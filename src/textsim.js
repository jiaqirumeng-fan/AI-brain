/* 海马体 · 文本/概念相似度
   不依赖任何外部服务：中文按字二元组，英文按词；TF-IDF 余弦 + 标签共现。
   这是「联想」的离线近似，可随时替换为向量模型。 */
(function (global) {
  'use strict';

  const HU = global.HU;
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

  function norm(s) { return String(s == null ? '' : s).toLowerCase(); }

  function tokenize(text, out) {
    const s = norm(text);
    let run = '';
    const flush = () => {
      if (run.length >= 2) {
        for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
      }
      run = '';
    };
    for (const ch of s) {
      if (CJK.test(ch)) run += ch;
      else flush();
    }
    flush();
    const latin = s.match(/[a-z][a-z0-9+#.\-]*/g) || [];
    for (const w of latin) if (w.length > 1) out.push(w);
  }

  function docTokens(node) {
    const out = [];
    // 标题权重最高，标签次之，摘要再次
    tokenize(node.title, out); tokenize(node.title, out);
    const tags = (node.tags || []).join(' ');
    tokenize(tags, out); tokenize(tags, out);
    tokenize(node.summary || '', out);
    return out;
  }

  const cache = new Map();

  function buildIndex(nodes) {
    const key = nodes.map((n) => n.id + '\u0001' + (n.title || '') + '\u0001' + (n.summary || '') + '\u0001' + (n.tags || []).join(',')).join('\u0002');
    if (cache.has(key)) return cache.get(key);

    const docTf = new Map();
    const df = new Map();
    const N = Math.max(1, nodes.length);
    for (const n of nodes) {
      const tf = new Map();
      for (const t of docTokens(n)) tf.set(t, (tf.get(t) || 0) + 1);
      docTf.set(n.id, tf);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    const idf = new Map();
    for (const [t, c] of df) idf.set(t, Math.log((N + 1) / (c + 1)) + 1);

    const vecs = new Map();
    for (const n of nodes) {
      const tf = docTf.get(n.id);
      const v = new Map();
      let norm2 = 0;
      for (const [t, c] of tf) {
        const w = (1 + Math.log(c)) * (idf.get(t) || 1);
        v.set(t, w);
        norm2 += w * w;
      }
      vecs.set(n.id, { v, norm: Math.sqrt(norm2) || 1 });
    }
    const idx = { vecs, N, df };
    // 标签在整个脑里的稀有度（按标签原文统计）
    const tagDocFreq = new Map();
    for (const n of nodes) {
      for (const t of tagSet(n)) tagDocFreq.set(t, (tagDocFreq.get(t) || 0) + 1);
    }
    idx.tagDocFreq = tagDocFreq;
    cache.set(key, idx);
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    return idx;
  }

  function cosine(aId, bId, idx) {
    const A = idx.vecs.get(aId), B = idx.vecs.get(bId);
    if (!A || !B) return 0;
    const small = A.v.size <= B.v.size ? A : B;
    const big = small === A ? B : A;
    let dot = 0;
    for (const [t, w] of small.v) {
      const w2 = big.v.get(t);
      if (w2) dot += w * w2;
    }
    return HU.clamp(dot / (A.norm * B.norm), 0, 1);
  }

  function tagSet(node) {
    const s = new Set();
    for (const t of node.tags || []) {
      const v = norm(t).trim();
      if (v) s.add(v);
    }
    return s;
  }

  function scorePair(a, b, idx) {
    const cos = cosine(a.id, b.id, idx);
    const ta = tagSet(a), tb = tagSet(b);
    const shared = [];
    for (const t of ta) if (tb.has(t)) shared.push(t);
    const union = new Set([...ta, ...tb]);
    const jac = union.size ? shared.length / union.size : 0;

    /* 共享标签是「概念钩子」：越稀有越有说服力 */
    let tagScore = 0;
    for (const t of shared) {
      const df = idx.tagDocFreq.get(t) || 1;
      tagScore += df <= 2 ? 0.36 : df <= 5 ? 0.28 : 0.17;
    }
    tagScore = Math.min(0.62, tagScore);

    let score = 0.82 * cos + tagScore + (shared.length ? 0.08 : 0.02);
    score = HU.clamp(score, 0, 0.98);
    return { score, cos, jac, shared };
  }

  global.TextSim = { tokenize, buildIndex, cosine, scorePair, docTokens };
})(typeof window !== 'undefined' ? window : globalThis);
