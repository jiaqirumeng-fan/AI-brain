#!/usr/bin/env node
'use strict';
/* 海马体 · DSH MCP server
 *
 * 一个进程同时做两件事：
 *   1. stdio MCP server：给 DSH 提供 memory_recall / memory_add / memory_link / memory_stats / memory_due / memory_get
 *   2. 本地 HTTP API + 静态站点：让脑图界面读写同一份 data/brain.json（默认 127.0.0.1:8130）
 *
 * 注意：stdout 是 MCP 的 JSON-RPC 通道，任何日志只能走 stderr。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { MemoryService } = require('./memory-service.js');
const { KnowledgeBase } = require('./knowledge-base.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.HIPPOCAMPUS_HTTP_PORT || 8130);
const BIND_HOST = process.env.HIPPOCAMPUS_HOST || '0.0.0.0';
const DATA_DIR = process.env.HIPPOCAMPUS_DATA_DIR ||
  (process.env.HIPPOCAMPUS_DATA
    ? path.dirname(path.resolve(process.env.HIPPOCAMPUS_DATA))
    : path.join(ROOT, 'data'));
const SENSE_DIR = process.env.HIPPOCAMPUS_SENSE_DIR || path.join(DATA_DIR, 'senses');
const TOKEN_FILE = process.env.HIPPOCAMPUS_TOKEN_FILE || path.join(DATA_DIR, 'mobile-token.txt');

fs.mkdirSync(SENSE_DIR, { recursive: true });

const service = new MemoryService({ root: ROOT });
const kb = new KnowledgeBase({ service, root: ROOT });
const sseClients = new Set();
const MOBILE_TOKEN = loadMobileToken();

/* ══════════════ 手机感官：配对与局域网 ══════════════ */
function loadMobileToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (token) return token;
  } catch (e) { /* first run */ }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token + '\n', 'utf8');
  } catch (e) { /* ignore */ }
  return token;
}

function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function tokenOf(req, url) {
  const header = req.headers['x-hippocampus-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return (url && url.searchParams.get('token')) || '';
}

function tokenOk(token) {
  if (!token || token.length !== MOBILE_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(MOBILE_TOKEN));
  } catch (e) {
    return false;
  }
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const score = /^192\.168\./.test(item.address) ? 3
        : /^10\./.test(item.address) ? 2
          : /^172\.(1[6-9]|2\d|3[01])\./.test(item.address) ? 1 : 0;
      out.push({
        name,
        address: item.address,
        preferred: /wi-?fi|wlan|ethernet|以太网/i.test(name),
        score
      });
    }
  }
  out.sort((a, b) => (Number(b.preferred) - Number(a.preferred)) || (b.score - a.score));
  return out;
}

function pythonExe() {
  if (process.env.HIPPOCAMPUS_PYTHON) return process.env.HIPPOCAMPUS_PYTHON;
  const bundled = path.join(
    os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime',
    'dependencies', 'python', 'python.exe'
  );
  return fs.existsSync(bundled) ? bundled : 'python';
}

function generateQr(url) {
  const out = path.join(DATA_DIR, 'mobile-qr.svg');
  const vendor = path.join(__dirname, 'vendor', 'python');
  const oldPath = process.env.PYTHONPATH || '';
  const env = Object.assign({}, process.env, {
    PYTHONPATH: vendor + (oldPath ? path.delimiter + oldPath : ''),
    PYTHONIOENCODING: 'utf-8'
  });
  const res = spawnSync(pythonExe(), [path.join(__dirname, 'make_qr.py'), url, out], {
    env,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  });
  if (res.error || res.status !== 0) {
    console.error('[hippocampus] QR failed:', (res.error && res.error.message) || (res.stderr || '').trim());
    return null;
  }
  try {
    return fs.readFileSync(out);
  } catch (e) {
    return null;
  }
}

function clockText() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function inferSenseDomain(text) {
  const t = String(text || '');
  if (/矩阵|向量|特征值|线性代数/.test(t)) return '线性代数';
  if (/物理|化学|生物|实验|电磁|热力学/.test(t)) return '大学物理';
  if (/数学|极限|导数|积分|概率|函数|公式/.test(t)) return '高等数学';
  if (/DSH|MCP|代码|程序|算法|电脑|手机|知识库|记忆|脑图|接口/.test(t)) return '计算机 · AI';
  if (/项目|比赛|答辩|评委|产品|方案/.test(t)) return '项目 · 竞赛';
  return '学习科学';
}

function senseTags(text, extra) {
  const keys = ['手机', '照片', '录音', '语音', '课堂', '白板', '笔记', '实验', '项目', '答辩', '复习', '公式', '题目', '代码', '知识库'];
  const out = extra.slice();
  for (const key of keys) {
    if (String(text || '').indexOf(key) >= 0 && out.indexOf(key) < 0) out.push(key);
  }
  return out.slice(0, 8);
}

function senseRecent(limit, includeFile) {
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  return service.snapshot().nodes
    .filter((node) => node.source && /^phone-/.test(node.source.kind))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, n)
    .map((node) => ({
      id: node.id,
      title: node.title,
      summary: node.summary,
      kind: node.source.kind,
      name: node.source.name || null,
      ...(includeFile ? { file: node.source.file || null, path: node.source.path || null } : {}),
      mime: node.source.mime || null,
      duration: node.source.duration || null,
      createdAt: node.createdAt,
      url: node.source.name ? '/api/sense/file/' + encodeURIComponent(node.source.name) : null
    }));
}

/* ══════════════ MCP 工具定义 ══════════════ */
const TOOLS = [
  {
    name: 'memory_recall',
    description: '从用户的「海马体」长期记忆里召回相关知识点。回答任何可能涉及用户以前学过/做过的内容之前先调用它；返回可提取度（retrievability）与相关记忆，默认会把本次命中的前几条标记为“被调用”，让它们在脑图里变亮。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆的主题、问题或关键词，例如「傅里叶 降噪」「上次的错题本项目」' },
        limit: { type: 'integer', minimum: 1, maximum: 8, description: '返回条数，默认 5' },
        touch: { type: 'boolean', description: '是否把命中的记忆记为一次真实调用（默认 true）' }
      },
      required: ['query'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: 'memory_add',
    description: '把一条值得长期保留的学习记忆写入海马体：用户说“记住/记一下/这个要留着”，或对话产生了一个明确的知识点、结论、项目决策时调用。标题要具体，标签是以后联想的钩子。写入后会自动返回潜在关联。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '具体标题，例如「用傅里叶变换给心电信号降噪」' },
        summary: { type: 'string', description: '一到三句话：它是什么、解决什么问题、和什么有关' },
        domain: { type: 'string', description: '领域 id 或名称，例如 math / 高等数学 / project / 项目·竞赛；不存在会自动新建' },
        tags: { type: 'array', items: { type: 'string' }, description: '2–5 个概念标签，例如 ["傅里叶","降噪","信号"]' },
        importance: { type: 'number', minimum: 0.05, maximum: 1, description: '重要度 0–1，默认 0.6；越重要的记忆越不容易褪色' },
        auto_link: { type: 'boolean', description: '是否自动建立最强的 1–2 条突触，默认 false' }
      },
      required: ['title'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: 'memory_link',
    description: '在两个已有记忆之间建立一条突触。当对话中发现两条记忆有明确关系（同一概念、因果、类比、跨学科迁移）时调用。跨领域会自动标成 bridge（跨域桥）。',
    inputSchema: {
      type: 'object',
      properties: {
        a_id: { type: 'string', description: '记忆 A 的 id' },
        b_id: { type: 'string', description: '记忆 B 的 id' },
        reason: { type: 'string', description: '为什么连：一句话说明关系' },
        kind: { type: 'string', enum: ['assoc', 'bridge', 'coact'], description: '可选；默认按是否同领域自动判断' }
      },
      required: ['a_id', 'b_id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: 'memory_stats',
    description: '读取整张记忆网络的状态：节点数、突触数、跨域桥、平均可提取度、各脑区情况、领域连通度、最该复习的节点。用户问“我的大脑/记忆状态怎么样”时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'memory_due',
    description: '列出当前最该复习的记忆（按“重要度 × 遗忘程度”排序）。用户问“我该复习什么/最近忘了什么”时调用。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 10, description: '返回条数，默认 5' } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'memory_get',
    description: '按 id 查看一条记忆的完整内容、遗忘曲线参数与它的所有突触。需要引用某条记忆的细节时调用。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆 id' } },
      required: ['id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'memory_import',
    description: '扫描知识库文件夹 knowledge/，把新增或修改过的资料切块写入记忆。用户问“知识库有什么/更新一下知识库”，或刚把文件放进 knowledge/ 时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false }
  },
  {
    name: 'memory_import_file',
    description: '把一个本地文件导入知识库并入库（支持 .md/.txt/.json/.docx/.pptx/.xlsx/.pdf/图片）。用户给你一个文件路径、说“把这个存进知识库”时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        domain: { type: 'string', description: '可选：领域 id 或名称；不传则按文件所在文件夹/内容自动判断' }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: 'memory_kb_status',
    description: '查看知识库状态：已索引文件数、生成的记忆节点数、最近扫描时间与错误。用户问“知识库里有什么/为什么没入库”时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'memory_sense_recent',
    description: '列出最近从手机送来的照片/录音/文字记忆。用户说“看看我刚拍的/刚录的”时先调用它；照片的 source.file 可以用 read_image 读取。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8' } },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  }
];

/* ══════════════ 工具实现 ══════════════ */
const HANDLERS = {
  memory_recall(args) {
    const query = String(args.query == null ? '' : args.query);
    if (!query.trim()) throw new Error('query 不能为空');
    const { hits, strengthened } = service.recall(query, args.limit, args.touch !== false);
    const results = hits.map((h) => service.serializeHit(h));
    // 给前两条附上邻居，帮助模型理解“它会带出什么”
    for (let i = 0; i < Math.min(2, results.length); i++) {
      const detail = service.get(results[i].id);
      if (detail) {
        results[i].neighbors = detail.neighbors.slice(0, 5).map((n) => ({
          id: n.id,
          title: n.title,
          weight: n.weight,
          kind: n.kind,
          reason: n.reason
        }));
      }
    }
    return {
      query,
      count: results.length,
      results,
      strengthened: strengthened.length,
      note: results.length
        ? 'retrievability 是当前可提取度（0–1）；越低越接近遗忘。需要细节可再用 memory_get。'
        : '没有找到相关记忆。如果这是用户第一次提到这个主题，可以建议用 memory_add 记下来。'
    };
  },

  memory_add(args) {
    const title = String(args.title == null ? '' : args.title).trim();
    if (!title) throw new Error('title 不能为空');
    const out = service.add({
      title,
      summary: args.summary,
      domain: args.domain,
      tags: args.tags,
      importance: args.importance,
      auto_link: !!args.auto_link
    });
    const domain = out.domain;
    const node = service.get(out.node.id);
    return {
      id: out.node.id,
      node,
      domain: { id: domain.id, name: domain.name },
      proposals: out.proposals.map((p) => service.describeProposal(p)),
      linked: out.linked.map((s) => s.id),
      note: out.proposals.length
        ? '已发现潜在关联。可以调用 memory_link 采纳其中一条，或无视。'
        : '暂未发现强关联；可以稍后用 memory_link 手动连接。'
    };
  },

  memory_link(args) {
    const out = service.link(String(args.a_id || ''), String(args.b_id || ''), {
      reason: args.reason,
      kind: args.kind
    });
    return {
      synapse_id: out.synapse.id,
      existed: out.existed,
      kind: out.synapse.kind,
      weight: Math.round(out.synapse.weight * 100) / 100,
      message: out.existed ? '这两个记忆之间已经有突触了。' : '突触已建立。'
    };
  },

  memory_stats() {
    return service.stats();
  },

  memory_due(args) {
    return { due: service.due(args.limit) };
  },

  memory_get(args) {
    const out = service.get(String(args.id || ''));
    if (!out) throw new Error('找不到这条记忆：' + args.id);
    return out;
  },

  memory_import() {
    const scan = kb.scan('tool');
    return { scan, status: kb.status() };
  },

  memory_import_file(args) {
    const file = path.resolve(String(args.path || ''));
    if (!fs.existsSync(file)) throw new Error('文件不存在：' + file);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('不是文件：' + file);
    const out = kb.upload(fs.readFileSync(file), path.basename(file), args.domain);
    return { file: out.file, added: out.added, title: out.title, status: kb.status() };
  },

  memory_kb_status() {
    return kb.status();
  },

  memory_sense_recent(args) {
    const results = senseRecent(args.limit, true);
    return { count: results.length, results };
  }
};

function toolResult(text, isError) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {})
  };
}

/* ══════════════ MCP stdio ══════════════ */
const HTTP_ONLY = process.argv.includes('--http-only');
let buffer = '';
let initialized = false;

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (e) { /* stdout closed */ }
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (!msg.method) return; // response from client, ignore
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    initialized = true;
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hippocampus', version: '0.1.0' },
      instructions: [
        '你接入了用户的「海马体」长期记忆网络。',
        '每一轮回答前，先调用 memory_recall：query 用用户这句话的主题；即使只是普通问题也先查一次。命中就自然使用，没命中就正常回答，不要向用户复述检索过程。',
        '回答结束前自检：如果本轮产生了新的、可复用的知识点、结论或项目决策，调用 memory_add 保存 0–1 条；用户明确说“记住/记一下/保存”时必须保存。寒暄、临时进度、重复内容不保存。',
        '当发现两条记忆有明确关系时调用 memory_link；跨领域联系尤其有价值。',
        '用户问“我的大脑/记忆状态/该复习什么”时，调用 memory_stats 或 memory_due。',
        '知识库：用户把文件放进 knowledge/ 或从脑图拖拽上传后会自动入库；用户问知识库、或让你导入某个文件时，用 memory_import / memory_import_file / memory_kb_status。',
        '手机感官：source.kind 为 phone-photo / phone-audio / phone-note 的记忆来自手机；照片可以用 read_image 读取 source.file，音频先看备注与时长。用户说“看看我刚拍的/刚录的”时先调用 memory_sense_recent。',
        '不要编造记忆里没有的内容；召回为空就如实说，并可以建议记下来。'
      ].join('\n')
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'ping') {
    reply(id, {});
    return;
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const handler = HANDLERS[name];
    if (!handler) {
      reply(id, toolResult('未知工具：' + name, true));
      return;
    }
    try {
      const out = handler(args);
      reply(id, toolResult(JSON.stringify(out, null, 2), false));
    } catch (err) {
      reply(id, toolResult('海马体操作失败：' + (err && err.message ? err.message : String(err)), true));
    }
    return;
  }

  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }
  if (method === 'logging/setLevel') {
    reply(id, {});
    return;
  }

  if (!isNotification) replyError(id, -32601, 'Method not found: ' + method);
}

if (!HTTP_ONLY) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (err) {
        replyError(null, -32700, 'Parse error');
      }
    }
  });
  process.stdin.on('end', () => {
    try { httpServer.close(); } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(0), 40);
  });
}
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

/* ══════════════ HTTP API + 静态站点 ══════════════ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.3gp': 'audio/3gpp',
  '.amr': 'audio/amr',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4'
};

const IMAGE_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const AUDIO_EXT = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'audio/x-m4a': '.m4a',
  'audio/3gpp': '.3gp',
  'audio/amr': '.amr',
  'audio/x-flac': '.flac',
  'audio/flac': '.flac'
};

function setCors(req, res) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const sameOrigin = !!(origin && host && (origin === 'http://' + host || origin === 'https://' + host));
  if (origin && origin !== 'null' && !sameOrigin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hippocampus-Token');
  res.setHeader('Vary', 'Origin');
  return true;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function readBody(req, limit) {
  const max = limit || 30 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('文件过大（>30MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const mobileFile = pathname === '/m' || pathname === '/m/'
    ? '/mobile/index.html'
    : pathname.startsWith('/m/') ? '/mobile/' + pathname.slice(3) : null;
  const allowed = mobileFile !== null || pathname === '/' || pathname === '/index.html' ||
    pathname.startsWith('/src/') || pathname.startsWith('/screenshots/');
  if (!allowed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const relPath = mobileFile || (pathname === '/' ? '/index.html' : pathname);
  let file = path.normalize(path.join(ROOT, relPath));
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': data.length
    });
    res.end(data);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname || '/');

  if (!setCors(req, res)) {
    res.writeHead(403);
    res.end('Forbidden origin');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const loopback = isLoopback(req);
  const mobilePage = pathname === '/m' || pathname === '/m/' || pathname.startsWith('/m/');
  const senseApi = pathname.startsWith('/api/sense/');
  if (!loopback && !mobilePage && !senseApi) {
    json(res, 403, { ok: false, error: 'LAN access is limited to the phone sensory pages' });
    return;
  }
  if (!loopback && senseApi && !tokenOk(tokenOf(req, url))) {
    json(res, 401, { ok: false, error: 'pairing token required' });
    return;
  }

  try {
    if (pathname === '/api/health') {
      json(res, 200, {
        ok: true,
        name: 'hippocampus',
        rev: service.snapshot().rev,
        nodes: service.snapshot().nodes.length,
        synapses: service.snapshot().synapses.length,
        updatedAt: service.snapshot().updatedAt || null,
        port: PORT
      });
      return;
    }

    if (pathname === '/api/mobile-info' && req.method === 'GET') {
      const addresses = lanAddresses();
      const address = addresses.length ? addresses[0].address : null;
      const url = address ? 'http://' + address + ':' + PORT + '/m?token=' + MOBILE_TOKEN : null;
      json(res, 200, {
        ok: true,
        port: PORT,
        token: MOBILE_TOKEN,
        addresses,
        url,
        qr: url ? '/api/mobile-qr' : null
      });
      return;
    }

    if (pathname === '/api/mobile-qr' && req.method === 'GET') {
      const addresses = lanAddresses();
      const address = addresses.length ? addresses[0].address : null;
      const url = address ? 'http://' + address + ':' + PORT + '/m?token=' + MOBILE_TOKEN : null;
      if (!url) {
        json(res, 404, { ok: false, error: 'no LAN IPv4 address' });
        return;
      }
      const svg = generateQr(url);
      if (!svg) {
        json(res, 500, { ok: false, error: 'QR generation failed' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': svg.length
      });
      res.end(svg);
      return;
    }

    if (pathname === '/api/state' && req.method === 'GET') {
      json(res, 200, service.snapshot());
      return;
    }

    if (pathname === '/api/state' && req.method === 'POST') {
      const body = await readJson(req);
      const out = service.replace(body.state, body.baseRev, body.source || 'ui', !!body.force);
      json(res, 200, { ok: true, rev: out.rev, merged: out.merged, state: out.state });
      return;
    }

    if (pathname === '/api/recall' && req.method === 'POST') {
      const body = await readJson(req);
      const touched = service.touch(body.ids);
      json(res, 200, { ok: true, touched, rev: service.snapshot().rev });
      return;
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      json(res, 200, service.stats());
      return;
    }

    if (pathname === '/api/add' && req.method === 'POST') {
      const body = await readJson(req);
      const title = String(body.title == null ? '' : body.title).trim().slice(0, 120);
      if (!title) {
        json(res, 400, { ok: false, error: 'title required' });
        return;
      }
      const out = service.add({
        title,
        summary: String(body.summary == null ? '' : body.summary).slice(0, 4000),
        domain: body.domain,
        tags: body.tags,
        importance: body.importance,
        auto_link: body.auto_link !== false,
        source: body.source
      });
      json(res, 200, {
        ok: true,
        id: out.node.id,
        title: out.node.title,
        duplicate: !!out.duplicate,
        linked: out.linked.length,
        proposals: out.proposals.slice(0, 3).map((p) => ({ id: p.a.id, title: p.a.title, cross_domain: p.cross, score: Number(p.score.toFixed(3)) }))
      });
      return;
    }

    if (pathname === '/api/kb/status' && req.method === 'GET') {
      json(res, 200, Object.assign({ ok: true }, kb.status()));
      return;
    }

    if (pathname === '/api/sense/ping' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        nodes: service.snapshot().nodes.length,
        port: PORT,
        workspace: path.basename(ROOT)
      });
      return;
    }

    if (pathname === '/api/sense/recent' && req.method === 'GET') {
      const results = senseRecent(url.searchParams.get('limit'));
      json(res, 200, { ok: true, count: results.length, results });
      return;
    }

    if (pathname === '/api/sense/photo' && req.method === 'POST') {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_EXT[mime];
      if (!ext) {
        json(res, 415, { ok: false, error: 'unsupported image type: ' + mime });
        return;
      }
      const body = await readBody(req, 25 * 1024 * 1024);
      if (!body.length) {
        json(res, 400, { ok: false, error: 'empty image' });
        return;
      }
      const note = String(url.searchParams.get('note') || '').trim().slice(0, 300);
      const width = Math.max(0, Number(url.searchParams.get('w')) || 0);
      const height = Math.max(0, Number(url.searchParams.get('h')) || 0);
      const name = 'photo-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + ext;
      const target = path.join(SENSE_DIR, name);
      fs.writeFileSync(target, body);
      const title = note ? '照片：' + note.slice(0, 34) : '手机照片 · ' + clockText();
      const summary = '手机拍摄的照片。' +
        (note ? '\n备注：' + note : '\n（没有备注，等待 AI 解读）') +
        '\n文件：' + name;
      const out = service.add({
        title,
        summary,
        domain: inferSenseDomain(note),
        tags: senseTags(note, ['手机', '照片']),
        importance: 0.55,
        auto_link: true,
        source: {
          kind: 'phone-photo',
          name,
          path: 'data/senses/' + name,
          file: target,
          mime,
          width,
          height,
          at: Date.now()
        }
      });
      json(res, 200, {
        ok: true,
        id: out.node.id,
        title: out.node.title,
        duplicate: !!out.duplicate,
        url: '/api/sense/file/' + encodeURIComponent(name)
      });
      return;
    }

    if (pathname === '/api/sense/audio' && req.method === 'POST') {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = AUDIO_EXT[mime];
      if (!ext) {
        json(res, 415, { ok: false, error: 'unsupported audio type: ' + mime });
        return;
      }
      const body = await readBody(req, 30 * 1024 * 1024);
      if (!body.length) {
        json(res, 400, { ok: false, error: 'empty audio' });
        return;
      }
      const note = String(url.searchParams.get('note') || '').trim().slice(0, 300);
      const duration = Math.max(0, Number(url.searchParams.get('duration')) || 0);
      const name = 'audio-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + ext;
      const target = path.join(SENSE_DIR, name);
      fs.writeFileSync(target, body);
      const title = note ? '录音：' + note.slice(0, 34) : '手机录音 · ' + clockText();
      const summary = '手机录音。' +
        (note ? '\n备注：' + note : '\n（没有备注）') +
        (duration > 0 ? '\n时长：' + duration.toFixed(1) + ' 秒' : '') +
        '\n文件：' + name;
      const out = service.add({
        title,
        summary,
        domain: inferSenseDomain(note),
        tags: senseTags(note, ['手机', '录音']),
        importance: 0.55,
        auto_link: true,
        source: {
          kind: 'phone-audio',
          name,
          path: 'data/senses/' + name,
          file: target,
          mime,
          duration,
          at: Date.now()
        }
      });
      json(res, 200, {
        ok: true,
        id: out.node.id,
        title: out.node.title,
        duplicate: !!out.duplicate,
        url: '/api/sense/file/' + encodeURIComponent(name)
      });
      return;
    }

    if (pathname === '/api/sense/note' && req.method === 'POST') {
      const body = await readJson(req);
      const text = String(body.text == null ? '' : body.text).trim().slice(0, 4000);
      if (!text) {
        json(res, 400, { ok: false, error: 'text required' });
        return;
      }
      const first = (text.split(/[。！？!?\n]/)[0] || text).trim();
      const title = (first.length >= 4 ? first : text).slice(0, 44);
      const out = service.add({
        title,
        summary: text,
        domain: inferSenseDomain(text),
        tags: senseTags(text, ['手机', '文字']),
        importance: 0.6,
        auto_link: true,
        source: { kind: 'phone-note', at: Date.now() }
      });
      json(res, 200, { ok: true, id: out.node.id, title: out.node.title, duplicate: !!out.duplicate });
      return;
    }

    if (pathname.startsWith('/api/sense/file/') && req.method === 'GET') {
      const raw = pathname.slice('/api/sense/file/'.length);
      const name = path.basename(decodeURIComponent(raw));
      if (!name || name.startsWith('.')) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const file = path.join(SENSE_DIR, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (e) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      if (!stat.isFile()) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
        if (match) {
          let start = match[1] ? Number(match[1]) : 0;
          let end = match[2] ? Number(match[2]) : stat.size - 1;
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
            res.end();
            return;
          }
          end = Math.min(end, stat.size - 1);
          res.writeHead(206, {
            'Content-Type': mime,
            'Content-Length': end - start + 1,
            'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=3600'
          });
          fs.createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600'
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (pathname === '/api/kb/scan' && req.method === 'POST') {
      const result = kb.scan('web');
      json(res, 200, { ok: true, scan: result, status: kb.status() });
      return;
    }

    if (pathname === '/api/kb/upload' && req.method === 'POST') {
      const name = url.searchParams.get('name') || 'upload.bin';
      const domain = url.searchParams.get('domain') || '';
      const body = await readBody(req);
      const out = kb.upload(body, name, domain);
      json(res, 200, { ok: true, file: out.file, added: out.added, title: out.title, status: kb.status() });
      return;
    }

    if (pathname === '/api/kb/open' && req.method === 'POST') {
      try {
        const { spawn } = require('child_process');
        const cmd = process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
        spawn(cmd, [kb.dir], { detached: true, stdio: 'ignore' }).unref();
        json(res, 200, { ok: true, dir: kb.dir });
      } catch (e) {
        json(res, 200, { ok: false, dir: kb.dir, error: e.message });
      }
      return;
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    json(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
  }
});

function broadcast(ev) {
  const payload = 'event: state\ndata: ' + JSON.stringify(ev) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}
service.onChange(broadcast);

const heartbeat = setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); }
  }
}, 25000);
heartbeat.unref();

httpServer.on('error', (err) => {
  console.error('[hippocampus] HTTP unavailable:', err && err.message ? err.message : err);
});
httpServer.listen(PORT, BIND_HOST, () => {
  console.error('[hippocampus] memory service ready · http://127.0.0.1:' + PORT + '/');
  console.error('[hippocampus] data: ' + service.dataFile);
  console.error('[hippocampus] knowledge: ' + kb.dir);
  console.error('[hippocampus] phone token: ' + TOKEN_FILE);
  const addresses = lanAddresses();
  if (addresses.length) {
    console.error('[hippocampus] phone page: http://' + addresses[0].address + ':' + PORT + '/m');
  } else {
    console.error('[hippocampus] phone page: no LAN IPv4 address detected');
  }
  kb.start();
});
