/* 海马体 · 记忆模型
   核心不是「存储」，而是「可提取度」：
     R(t) = exp(-Δt / S)          Δt = 距上次成功回想的天然天数
     S 为记忆稳定度；每次回想后 S 增长，间隔越久增长越多（间隔效应）
   突触：w(t) = w0 * 0.5^(Δt / halfLife)，被共同激活时增强。
*/
(function (global) {
  'use strict';

  const HU = global.HU;
  const TS = global.TextSim;
  const DAY = HU.DAY;
  const MAX_STABILITY = 900; // 天

  const HALF_LIFE = { assoc: 160, bridge: 240, coact: 45 };

  const Model = {};

  Model.LABEL = function (r) {
    if (r >= 0.8) return '清晰';
    if (r >= 0.55) return '稳固';
    if (r >= 0.32) return '模糊';
    if (r >= 0.14) return '边缘';
    return '濒临遗忘';
  };

  Model.initialStability = function (node) {
    return 8 + 22 * HU.clamp(node.importance == null ? 0.6 : node.importance, 0, 1);
  };

  Model.retention = function (node, now) {
    const base = node.lastRecalledAt || node.createdAt || now;
    const dt = Math.max(0, now - base) / DAY;
    const s = Math.max(0.6, node.stability || Model.initialStability(node));
    return Math.exp(-dt / s);
  };

  /* 视觉亮度：低可提取度时保留一点「痕迹」，而不是彻底消失 */
  Model.visual = function (node, now) {
    return 0.14 + 0.86 * Math.pow(Model.retention(node, now), 0.55);
  };

  Model.synapseWeight = function (syn, now) {
    const base = syn.lastActive || syn.createdAt || now;
    const dt = Math.max(0, now - base) / DAY;
    const hl = HALF_LIFE[syn.kind] || HALF_LIFE.assoc;
    return HU.clamp((syn.weight || 0) * Math.pow(0.5, dt / hl), 0, 1);
  };

  Model.isDormant = function (syn, now) {
    return Model.synapseWeight(syn, now) < 0.055;
  };

  Model.findNode = function (state, id) {
    return state.nodes.find((n) => n.id === id) || null;
  };

  Model.domain = function (state, id) {
    return state.domains.find((d) => d.id === id) || null;
  };

  Model.nodeDomain = function (state, node) {
    return Model.domain(state, node && node.domain);
  };

  /* 回想：重置遗忘计时，提高稳定度 */
  Model.recall = function (state, id, now) {
    const node = Model.findNode(state, id);
    if (!node) return null;
    const before = Model.retention(node, now);
    const last = node.lastRecalledAt || node.createdAt || now;
    const gapDays = Math.max(0, (now - last) / DAY);
    const sBefore = node.stability || Model.initialStability(node);

    const massed = gapDays < 0.04; // 一小时内反复点，属于集中重复
    let factor;
    if (massed) {
      factor = 1.05;
    } else {
      factor = 1.62 * (1 + Math.min(0.75, 0.18 * Math.log1p(gapDays)));
      if (before < 0.15) factor *= 1.2; // 重学节省：几乎忘了再捡回来，提升更大
    }
    node.stability = Math.min(MAX_STABILITY, sBefore * factor + 0.6);
    node.lastRecalledAt = now;
    node.recallCount = (node.recallCount || 0) + 1;

    return {
      node,
      before,
      after: Model.retention(node, now),
      stabilityBefore: sBefore,
      stabilityAfter: node.stability,
      massed,
      gapDays
    };
  };

  /* 预览：现在回想一次，稳定度会变成多少 */
  Model.previewRecall = function (node, now) {
    const before = Model.retention(node, now);
    const gapDays = Math.max(0, (now - (node.lastRecalledAt || node.createdAt)) / DAY);
    const s = node.stability || Model.initialStability(node);
    const massed = gapDays < 0.04;
    let factor = massed ? 1.05 : 1.62 * (1 + Math.min(0.75, 0.18 * Math.log1p(gapDays)));
    if (!massed && before < 0.15) factor *= 1.2;
    return {
      before,
      stability: Math.min(MAX_STABILITY, s * factor + 0.6),
      massed
    };
  };

  /* 沿突触扩散激活：相关连接被一起强化 */  Model.spread = function (state, id, now, amount) {
    let touched = 0;
    const boost = amount == null ? 0.035 : amount;
    for (const s of state.synapses) {
      if (s.source !== id && s.target !== id) continue;
      const w = Model.synapseWeight(s, now);
      s.weight = HU.clamp(w + boost * (1 - w), 0, 1);
      s.lastActive = now;
      if (s.nascent && s.weight > 0.34) s.nascent = false;
      touched++;
    }
    return touched;
  };

  Model.createSynapse = function (state, aId, bId, opts) {
    if (aId === bId) return null;
    const exists = state.synapses.find(
      (s) => (s.source === aId && s.target === bId) || (s.source === bId && s.target === aId)
    );
    if (exists) return null;
    const now = opts && opts.now ? opts.now : Date.now();
    const syn = {
      id: HU.uid('s_'),
      source: aId,
      target: bId,
      kind: (opts && opts.kind) || 'assoc',
      weight: opts && opts.weight != null ? opts.weight : 0.5,
      reason: (opts && opts.reason) || '',
      createdAt: now,
      lastActive: now,
      coactivations: 0,
      nascent: !!(opts && opts.nascent)
    };
    state.synapses.push(syn);
    return syn;
  };

  /* 共激活：同一段思考里先后调用两个记忆 → 突触形成/巩固（Hebb 规则） */
  Model.coactivate = function (state, aId, bId, now) {
    if (!aId || !bId || aId === bId) return null;
    const existing = state.synapses.find(
      (s) => (s.source === aId && s.target === bId) || (s.source === bId && s.target === aId)
    );
    if (existing) {
      const w = Model.synapseWeight(existing, now);
      const consolidated = !!existing.nascent;
      existing.weight = HU.clamp(w + (consolidated ? 0.22 : 0.09), 0, 1);
      existing.lastActive = now;
      existing.coactivations = (existing.coactivations || 0) + 1;
      existing.nascent = false;
      return { type: consolidated ? 'consolidated' : 'strengthened', synapse: existing };
    }
    const syn = Model.createSynapse(state, aId, bId, {
      kind: 'coact',
      weight: 0.2,
      reason: '共激活：在同一段思考中被先后调用',
      nascent: true,
      now
    });
    if (syn) syn.coactivations = 1;
    return syn ? { type: 'nascent', synapse: syn } : null;
  };

  Model.removeNode = function (state, id) {
    state.nodes = state.nodes.filter((n) => n.id !== id);
    state.synapses = state.synapses.filter((s) => s.source !== id && s.target !== id);
  };

  Model.addMemory = function (state, input, now) {
    now = now || Date.now();
    const node = {
      id: HU.uid('n_'),
      title: String(input.title || '').trim() || '未命名记忆',
      summary: String(input.summary || '').trim(),
      domain: input.domain,
      tags: (input.tags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8),
      importance: HU.clamp(input.importance == null ? 0.6 : input.importance, 0.05, 1),
      createdAt: now,
      lastRecalledAt: now,
      recallCount: 0,
      stability: Model.initialStability({ importance: input.importance == null ? 0.6 : input.importance })
    };
    state.nodes.push(node);
    return node;
  };

  Model.updateNode = function (state, id, patch) {
    const node = Model.findNode(state, id);
    if (!node) return null;
    ['title', 'summary', 'domain', 'tags', 'importance'].forEach((k) => {
      if (patch[k] != null) node[k] = patch[k];
    });
    if (patch.tags) node.tags = patch.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
    return node;
  };

  /* 语义联想：找到超过阈值的潜在联系 */
  function buildAdj(state, now) {
    const adj = new Map();
    const push = (a, b, w) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ id: b, w });
    };
    for (const s of state.synapses) {
      const w = Model.synapseWeight(s, now);
      if (w < 0.05) continue;
      push(s.source, s.target, w);
      push(s.target, s.source, w);
    }
    return adj;
  }

  /* 共同邻居：A–B、B–C 存在，A–C 尚未连接 → 间接联想 */
  function structuralScore(adj, aId, bId) {
    const A = adj.get(aId) || [];
    const B = adj.get(bId) || [];
    if (!A.length || !B.length) return { score: 0, via: [] };
    const mapB = new Map(B.map((x) => [x.id, x.w]));
    let sum = 0;
    const via = [];
    for (const x of A) {
      const w2 = mapB.get(x.id);
      if (!w2) continue;
      const deg = (adj.get(x.id) || []).length;
      const c = Math.min(x.w, w2) / Math.log(2 + deg);
      sum += c;
      via.push({ id: x.id, c });
    }
    via.sort((p, q) => q.c - p.c);
    return { score: HU.clamp(sum * 0.85, 0, 0.85), via: via.map((v) => v.id) };
  }

  Model.proposals = function (state, opts) {
    opts = opts || {};
    const threshold = opts.threshold == null ? 0.32 : opts.threshold;
    const scopedId = opts.nodeId || null;
    const limit = opts.limit || 40;
    const now = opts.now || Date.now();
    const nodes = state.nodes.filter((n) => !n.archived);
    if (!nodes.length) return [];
    const idx = TS.buildIndex(nodes);
    const adj = buildAdj(state, now);
    const out = [];

    const pair = (a, b) => {
      if (a.id === b.id) return;
      const exists = state.synapses.find(
        (s) => (s.source === a.id && s.target === b.id) || (s.source === b.id && s.target === a.id)
      );
      if (exists) return;
      const sem = TS.scorePair(a, b, idx);
      const str = structuralScore(adj, a.id, b.id);
      let score = Math.max(sem.score, str.score);
      if (sem.score > 0.2 && str.score > 0.2) score = Math.min(0.98, score + 0.04);
      if (score < threshold) return;
      const cross = a.domain !== b.domain;
      let basis = 'text';
      if (sem.shared.length) basis = 'concept';
      else if (str.via.length) basis = 'via';
      out.push({
        a, b, score, cross,
        cos: sem.cos,
        shared: sem.shared,
        via: str.via,
        basis,
        kind: cross ? 'bridge' : 'assoc'
      });
    };

    if (scopedId) {
      const a = Model.findNode(state, scopedId);
      if (!a) return [];
      for (const b of nodes) pair(a, b);
    } else {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) pair(nodes[i], nodes[j]);
      }
    }
    out.sort((x, y) => (y.score + (y.cross ? 0.03 : 0)) - (x.score + (x.cross ? 0.03 : 0)));
    return out.slice(0, limit);
  };

  Model.proposalReason = function (p) {
    if (p.basis === 'concept' && p.shared.length) return '共享概念：' + p.shared.slice(0, 3).join('、');
    if (p.basis === 'via' && p.via.length) return '间接联想（' + p.via.length + ' 个共同邻居）';
    if (p.shared.length) return '共享概念：' + p.shared.slice(0, 3).join('、');
    return '文本语义相近';
  };

  Model.stats = function (state, now) {
    const nodes = state.nodes;
    const rets = nodes.map((n) => Model.retention(n, now));
    const activeSyn = state.synapses.filter((s) => !Model.isDormant(s, now));
    const bridges = activeSyn.filter((s) => {
      const a = Model.findNode(state, s.source), b = Model.findNode(state, s.target);
      return a && b && a.domain !== b.domain;
    });
    const byDomain = {};
    for (const d of state.domains) {
      const list = nodes.filter((n) => n.domain === d.id);
      byDomain[d.id] = {
        count: list.length,
        retention: list.length ? HU.mean(list.map((n) => Model.retention(n, now))) : 0
      };
    }
    return {
      nodes: nodes.length,
      synapses: activeSyn.length,
      dormant: state.synapses.length - activeSyn.length,
      bridges: bridges.length,
      retention: HU.mean(rets),
      clear: rets.filter((r) => r >= 0.6).length,
      faded: rets.filter((r) => r < 0.2).length,
      byDomain
    };
  };

  /* 复习建议：重要、但正在变淡的记忆 */
  Model.due = function (state, now, n) {
    return state.nodes
      .map((node) => {
        const r = Model.retention(node, now);
        const age = (now - (node.lastRecalledAt || node.createdAt)) / DAY;
        const urgency = (1 - r) * (0.55 + 0.45 * (node.importance || 0.5)) + Math.min(0.25, age / 900);
        return { node, retention: r, urgency };
      })
      .filter((x) => x.retention < 0.72)
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, n || 3);
  };

  /* 跨域桥：帮助建立全局思维的那几条边 */
  Model.insights = function (state, now, n) {
    const list = [];
    for (const s of state.synapses) {
      const a = Model.findNode(state, s.source), b = Model.findNode(state, s.target);
      if (!a || !b || a.domain === b.domain) continue;
      const w = Model.synapseWeight(s, now);
      if (w < 0.08) continue;
      list.push({ synapse: s, a, b, weight: w });
    }
    list.sort((x, y) => y.weight - x.weight);
    return list.slice(0, n || 3);
  };

  /* 未来 N 天的保持率曲线 */
  Model.curve = function (node, now, days, steps) {
    const s = Math.max(0.6, node.stability || Model.initialStability(node));
    const arr = [];
    steps = steps || 60;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * days;
      arr.push({ day: t, r: Math.exp(-t / s) });
    }
    return arr;
  };

  Model.timeToThreshold = function (node, now, threshold) {
    const s = Math.max(0.6, node.stability || Model.initialStability(node));
    return Math.max(0, -Math.log(threshold == null ? 0.35 : threshold) * s);
  };

  global.Model = Model;
})(typeof window !== 'undefined' ? window : globalThis);
