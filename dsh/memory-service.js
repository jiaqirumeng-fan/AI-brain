'use strict';
/* 海马体 · 共享记忆服务
 *
 * 这是 DSH 与脑图界面之间的唯一数据源：
 *   data/brain.json  ——  节点、突触、领域、调用记录
 *
 * 由 dsh/mcp-hippocampus.js 作为 MCP server 启动时持有；
 * 同一进程还会开一个本地 HTTP API（默认 127.0.0.1:8130），
 * 让浏览器里的脑图读写同一份记忆。
 */

const fs = require('fs');
const path = require('path');

require('../src/util.js');
require('../src/textsim.js');
require('../src/model.js');
require('../src/seed.js');

const HU = globalThis.HU;
const Model = globalThis.Model;
const Seed = globalThis.Seed;
const TextSim = globalThis.TextSim;
const DAY = HU.DAY;

const PALETTE = ['#4cc9f0', '#8b7bff', '#ffa94d', '#2fe6a8', '#ff6b9a', '#ffd166', '#a0e57c', '#ff8fab', '#c4a7ff'];
const TOUCH_WINDOW_MS = 30 * 60 * 1000; // 30 分钟内重复召回不重复强化

function round(v, n) {
  const p = Math.pow(10, n == null ? 3 : n);
  return Math.round(v * p) / p;
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

class MemoryService {
  constructor(opts) {
    opts = opts || {};
    this.root = opts.root || path.resolve(__dirname, '..');
    this.dataFile = opts.dataFile || process.env.HIPPOCAMPUS_DATA || path.join(this.root, 'data', 'brain.json');
    this.listeners = new Set();
    this.state = null;
    this.load();
  }

  /* ─────────── 存取 ─────────── */
  load() {
    try {
      const raw = fs.readFileSync(this.dataFile, 'utf8');
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.nodes) || !Array.isArray(s.domains)) throw new Error('bad state');
      if (!Array.isArray(s.synapses)) s.synapses = [];
      if (!s.settings) s.settings = { threshold: 0.32 };
      s.rev = Number(s.rev) || 1;
      this.state = s;
      this.pruneDomains();
      return s;
    } catch (err) {
      const s = Seed.create();
      s.rev = 1;
      this.state = s;
      this.save();
      return s;
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      this.state.updatedAt = Date.now();
      const text = JSON.stringify(this.state, null, 2);
      const tmp = this.dataFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, text, 'utf8');
      try {
        fs.renameSync(tmp, this.dataFile);
      } catch (err) {
        fs.copyFileSync(tmp, this.dataFile);
        try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      console.error('[hippocampus] save failed:', err && err.message ? err.message : err);
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  commit(type, payload) {
    this.state.rev = (Number(this.state.rev) || 1) + 1;
    this.state.updatedAt = Date.now();
    this.save();
    const ev = Object.assign({ type, rev: this.state.rev, at: Date.now(), source: 'mcp' }, payload || {});
    for (const fn of this.listeners) {
      try { fn(ev); } catch (e) { /* ignore */ }
    }
    return ev;
  }

  snapshot() {
    return this.state;
  }

  replace(incoming, baseRev, source, force) {
    if (!incoming || !Array.isArray(incoming.nodes) || !Array.isArray(incoming.domains)) {
      throw new Error('invalid state');
    }
    if (!Array.isArray(incoming.synapses)) incoming.synapses = [];
    incoming.rev = Number(incoming.rev) || 0;
    const current = this.state;
    const merged = !force && Number(baseRev) !== Number(current.rev);
    const next = merged ? this.merge(current, incoming) : incoming;
    next.version = next.version || 2;
    next.rev = (Number(current.rev) || 1) + 1;
    next.updatedAt = Date.now();
    this.state = next;
    this.save();
    const ev = {
      type: 'ui-save',
      rev: next.rev,
      at: Date.now(),
      source: source || 'ui',
      merged
    };
    for (const fn of this.listeners) {
      try { fn(ev); } catch (e) { /* ignore */ }
    }
    return { rev: next.rev, merged, state: next };
  }

  /* 合并两版状态：按 id 取并集，本地（incoming）覆盖内容字段；
     记忆强度字段取“最近一次调用”的那一版，避免界面的一次保存把 DSH 刚做的回想冲掉。 */
  merge(a, b) {
    const out = {
      version: b.version || a.version,
      createdAt: a.createdAt || b.createdAt || Date.now(),
      updatedAt: Date.now(),
      rev: a.rev || 1,
      domains: [],
      nodes: [],
      synapses: [],
      settings: Object.assign({}, a.settings, b.settings),
      meta: Object.assign({}, a.meta, b.meta)
    };
    const dom = new Map();
    for (const d of a.domains) dom.set(d.id, d);
    for (const d of b.domains) dom.set(d.id, d);
    out.domains = [...dom.values()];

    const nodes = new Map();
    for (const n of a.nodes) nodes.set(n.id, n);
    for (const n of b.nodes) {
      const old = nodes.get(n.id);
      if (!old) {
        nodes.set(n.id, n);
        continue;
      }
      const latest = (n.lastRecalledAt || 0) >= (old.lastRecalledAt || 0) ? n : old;
      nodes.set(n.id, Object.assign({}, old, n, {
        stability: Math.max(old.stability || 0, n.stability || 0),
        lastRecalledAt: latest.lastRecalledAt,
        recallCount: Math.max(old.recallCount || 0, n.recallCount || 0),
        createdAt: Math.min(old.createdAt || Infinity, n.createdAt || Infinity)
      }));
    }
    out.nodes = [...nodes.values()];

    const syns = new Map();
    for (const s of a.synapses) syns.set(s.id, s);
    for (const s of b.synapses) {
      const old = syns.get(s.id);
      if (!old) {
        syns.set(s.id, s);
        continue;
      }
      syns.set(s.id, Object.assign({}, old, s, {
        weight: Math.max(old.weight || 0, s.weight || 0),
        lastActive: Math.max(old.lastActive || 0, s.lastActive || 0),
        coactivations: Math.max(old.coactivations || 0, s.coactivations || 0)
      }));
    }
    out.synapses = [...syns.values()];
    return out;
  }

  /* ─────────── 领域 ─────────── */
  domainOf(id) {
    return this.state.domains.find((d) => d.id === id) || null;
  }

  resolveDomain(input) {
    const raw = String(input == null ? '' : input).trim();
    if (raw) {
      const byId = this.state.domains.find((d) => d.id === raw);
      if (byId) return byId;
      const lower = raw.toLowerCase();
      const byName = this.state.domains.find((d) => String(d.name).toLowerCase() === lower);
      if (byName) return byName;
      // 文件夹常用简称：项目 → 项目 · 竞赛；数学 → 高等数学
      const fuzzy = this.state.domains.find((d) => {
        const name = String(d.name).toLowerCase();
        return name.includes(lower) || lower.includes(name);
      });
      if (fuzzy) return fuzzy;
    }
    const name = raw || '其他';
    const color = PALETTE[this.state.domains.length % PALETTE.length];
    const domain = { id: HU.uid('d_'), name, color };
    this.state.domains.push(domain);
    return domain;
  }

  /* ─────────── 检索 ─────────── */
  search(query, limit) {
    limit = Math.min(8, Math.max(1, Number(limit) || 5));
    const text = String(query == null ? '' : query).trim();
    if (!text) return [];
    const now = Date.now();
    const nodes = this.state.nodes;
    if (!nodes.length) return [];
    const pseudo = { id: '__query__', title: text, summary: '', tags: [], domain: '__query__' };
    const idx = TextSim.buildIndex(nodes.concat([pseudo]));
    const lower = text.toLowerCase();

    const hits = [];
    for (const n of nodes) {
      const sem = TextSim.cosine(n.id, '__query__', idx);
      const hay = ((n.title || '') + ' ' + (n.summary || '') + ' ' + (n.tags || []).join(' ')).toLowerCase();
      const direct = hay.indexOf(lower) >= 0 ? 0.3 : 0;
      const tagHit = (n.tags || []).some((t) => t && lower.indexOf(String(t).toLowerCase()) >= 0) ? 0.12 : 0;
      const r = Model.retention(n, now);
      const score = sem * 0.9 + direct + tagHit;
      if (score > 0.12) hits.push({ node: n, score, retention: r });
    }
    hits.sort((x, y) => (y.score + 0.03 * y.retention) - (x.score + 0.03 * x.retention));
    if (!hits.length) {
      // 兜底：标题/标签的逐字匹配
      for (const n of nodes) {
        const hay = ((n.title || '') + ' ' + (n.tags || []).join(' ')).toLowerCase();
        if (hay.indexOf(lower) >= 0) hits.push({ node: n, score: 0.05, retention: Model.retention(n, now) });
      }
    }
    return hits.slice(0, limit);
  }

  recall(query, limit, touch) {
    const hits = this.search(query, limit);
    const strengthened = [];
    if (touch !== false) {
      const now = Date.now();
      for (const h of hits.slice(0, 3)) {
        const last = h.node.lastRecalledAt || h.node.createdAt || 0;
        if (now - last < TOUCH_WINDOW_MS) continue;
        const res = Model.recall(this.state, h.node.id, now);
        if (res) {
          Model.spread(this.state, h.node.id, now, 0.028);
          strengthened.push(h.node.id);
        }
      }
      if (strengthened.length) this.commit('recall', { ids: strengthened });
    }
    return { hits, strengthened };
  }

  touch(ids) {
    const now = Date.now();
    const touched = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const node = this.state.nodes.find((n) => n.id === id);
      if (!node) continue;
      const last = node.lastRecalledAt || node.createdAt || 0;
      if (now - last < TOUCH_WINDOW_MS) continue;
      const res = Model.recall(this.state, id, now);
      if (res) {
        Model.spread(this.state, id, now, 0.028);
        touched.push(id);
      }
    }
    if (touched.length) this.commit('recall', { ids: touched });
    return touched;
  }

  /* ─────────── 写入 ─────────── */
  add(input, opts) {
    input = input || {};
    opts = opts || {};
    const now = Date.now();
    const domain = this.resolveDomain(input.domain);

    // 同标题 + 同摘要 + 同领域 + 10 分钟内 → 视为同一条（防止模型与自动捕获重复写入）
    const title = String(input.title == null ? '' : input.title).trim();
    const summary = String(input.summary == null ? '' : input.summary).trim();
    if (title) {
      const dup = this.state.nodes.find((n) =>
        n.title === title && String(n.summary || '').trim() === summary &&
        n.domain === domain.id && now - (n.createdAt || 0) < 10 * 60 * 1000
      );
      if (dup) {
        return { node: dup, domain, proposals: [], linked: [], duplicate: true };
      }
    }

    const rawTags = Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[,，]/);
    const tags = rawTags.map((t) => String(t).trim()).filter(Boolean)
      .filter((t, i, arr) => arr.indexOf(t) === i).slice(0, 8);

    const node = Model.addMemory(this.state, {
      title,
      summary,
      domain: domain.id,
      tags,
      importance: input.importance
    }, now);
    if (input.source) node.source = input.source;

    const proposals = Model.proposals(this.state, {
      nodeId: node.id,
      threshold: this.state.settings.threshold || 0.32,
      now,
      limit: 5
    });

    const linked = [];
    if (input.auto_link) {
      for (const p of proposals.slice(0, 2)) {
        const syn = Model.createSynapse(this.state, p.a.id, p.b.id, {
          kind: p.cross ? 'bridge' : 'assoc',
          weight: Math.min(0.9, 0.45 + 0.35 * p.score),
          reason: Model.proposalReason(p) + ' · DSH 录入时自动建立',
          now
        });
        if (syn) linked.push(syn);
      }
    }

    if (!opts.defer) this.commit('add', {
      ids: [node.id],
      node: node.title,
      source: node.source ? node.source.kind : null
    });
    return { node, domain, proposals, linked, duplicate: false };
  }

  pruneDomains() {
    const used = new Set(this.state.nodes.map((n) => n.domain));
    const before = this.state.domains.length;
    this.state.domains = this.state.domains.filter((d) => used.has(d.id));
    return before - this.state.domains.length;
  }

  removeNodes(ids, meta) {
    const set = new Set(ids || []);
    if (!set.size) return [];
    this.state.nodes = this.state.nodes.filter((n) => !set.has(n.id));
    this.state.synapses = this.state.synapses.filter((s) => !set.has(s.source) && !set.has(s.target));
    this.pruneDomains();
    this.commit('kb-remove', Object.assign({ ids: [...set] }, meta || {}));
    return [...set];
  }

  link(aId, bId, opts) {
    opts = opts || {};
    const a = this.state.nodes.find((n) => n.id === aId);
    const b = this.state.nodes.find((n) => n.id === bId);
    if (!a || !b) throw new Error('节点不存在：' + (!a ? aId : bId));
    const existing = this.state.synapses.find(
      (s) => (s.source === a.id && s.target === b.id) || (s.source === b.id && s.target === a.id)
    );
    if (existing) return { synapse: existing, existed: true };
    const cross = a.domain !== b.domain;
    const syn = Model.createSynapse(this.state, a.id, b.id, {
      kind: opts.kind || (cross ? 'bridge' : 'assoc'),
      weight: typeof opts.weight === 'number' ? opts.weight : 0.55,
      reason: opts.reason || 'DSH 在对话中建立的联系',
      now: Date.now()
    });
    if (!syn) throw new Error('创建突触失败');
    this.commit('link', { sourceNode: a.id, targetNode: b.id, a: a.id, b: b.id });
    return { synapse: syn, existed: false };
  }

  /* ─────────── 统计 ─────────── */
  coverage(now) {
    const pairs = new Map();
    for (const s of this.state.synapses) {
      const a = this.state.nodes.find((n) => n.id === s.source);
      const b = this.state.nodes.find((n) => n.id === s.target);
      if (!a || !b || a.domain === b.domain) continue;
      if (Model.synapseWeight(s, now) < 0.08) continue;
      const key = [a.domain, b.domain].sort().join('|');
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
    const total = this.state.domains.length * (this.state.domains.length - 1) / 2;
    const missing = [];
    for (let i = 0; i < this.state.domains.length; i++) {
      for (let j = i + 1; j < this.state.domains.length; j++) {
        const key = [this.state.domains[i].id, this.state.domains[j].id].sort().join('|');
        if (!pairs.has(key)) missing.push(this.state.domains[i].name + ' ↔ ' + this.state.domains[j].name);
      }
    }
    return { connected: pairs.size, total, missing };
  }

  stats() {
    const now = Date.now();
    const st = Model.stats(this.state, now);
    const cov = this.coverage(now);
    const due = Model.due(this.state, now, 5).map((d) => ({
      id: d.node.id,
      title: d.node.title,
      domain: (this.domainOf(d.node.domain) || {}).name || '',
      retrievability: round(d.retention, 2),
      urgency: round(d.urgency, 2)
    }));
    const bridges = Model.insights(this.state, now, 5).map((b) => ({
      a: b.a.title,
      b: b.b.title,
      weight: round(b.weight, 2),
      reason: b.synapse.reason || ''
    }));
    return {
      nodes: st.nodes,
      synapses: st.synapses,
      bridges: st.bridges,
      dormant_synapses: st.dormant,
      average_retrievability: round(st.retention, 3),
      clear: st.clear,
      fading: st.faded,
      domains: this.state.domains.map((d) => ({
        id: d.id,
        name: d.name,
        nodes: (st.byDomain[d.id] || {}).count || 0,
        average_retrievability: round((st.byDomain[d.id] || {}).retention || 0, 3)
      })),
      coverage: { connected: cov.connected, total: cov.total, missing: cov.missing },
      due,
      bridges_top: bridges
    };
  }

  due(limit) {
    const now = Date.now();
    return Model.due(this.state, now, Math.min(10, Math.max(1, Number(limit) || 5))).map((d) => ({
      id: d.node.id,
      title: d.node.title,
      domain: (this.domainOf(d.node.domain) || {}).name || '',
      tags: d.node.tags || [],
      retrievability: round(d.retention, 3),
      stability_days: round(d.node.stability || Model.initialStability(d.node), 1),
      last_recalled: iso(d.node.lastRecalledAt),
      urgency: round(d.urgency, 3)
    }));
  }

  get(id) {
    const now = Date.now();
    const node = this.state.nodes.find((n) => n.id === id);
    if (!node) return null;
    const domain = this.domainOf(node.domain) || { name: '', id: '' };
    const neighbors = [];
    for (const s of this.state.synapses) {
      if (s.source !== id && s.target !== id) continue;
      const otherId = s.source === id ? s.target : s.source;
      const other = this.state.nodes.find((n) => n.id === otherId);
      if (!other) continue;
      const w = Model.synapseWeight(s, now);
      if (w < 0.05) continue;
      neighbors.push({
        id: other.id,
        title: other.title,
        domain: (this.domainOf(other.domain) || {}).name || '',
        weight: round(w, 2),
        kind: s.kind,
        reason: s.reason || '',
        nascent: !!s.nascent
      });
    }
    neighbors.sort((a, b) => b.weight - a.weight);
    return {
      id: node.id,
      title: node.title,
      summary: node.summary,
      domain: domain.name,
      domain_id: domain.id,
      tags: node.tags || [],
      importance: node.importance,
      retrievability: round(Model.retention(node, now), 3),
      stability_days: round(node.stability || Model.initialStability(node), 1),
      created_at: iso(node.createdAt),
      last_recalled: iso(node.lastRecalledAt),
      recall_count: node.recallCount || 0,
      source: node.source || null,
      neighbors: neighbors.slice(0, 12)
    };
  }

  serializeHit(hit) {
    const n = hit.node;
    const domain = this.domainOf(n.domain) || { name: '', id: '' };
    return {
      id: n.id,
      title: n.title,
      domain: domain.name,
      tags: n.tags || [],
      summary: String(n.summary || '').slice(0, 600),
      retrievability: round(hit.retention, 3),
      stability_days: round(n.stability || Model.initialStability(n), 1),
      last_recalled: iso(n.lastRecalledAt),
      recall_count: n.recallCount || 0,
      source: n.source || null,
      relevance: round(hit.score, 3)
    };
  }

  describeProposal(p) {
    const domain = this.domainOf(p.b.domain) || { name: '' };
    return {
      id: p.b.id,
      title: p.b.title,
      domain: domain.name,
      cross_domain: !!p.cross,
      score: round(p.score, 2),
      reason: Model.proposalReason(p)
    };
  }
}

module.exports = { MemoryService, round, iso };
