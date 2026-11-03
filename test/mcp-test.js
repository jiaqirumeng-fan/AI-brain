'use strict';
/* 用真实 stdio 驱动一次 MCP server，验证 initialize / tools/list / tools/call 与 HTTP API */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(__dirname, 'mcp_brain.json');
const KB_DIR = path.join(__dirname, 'mcp_kb');
const KB_INDEX = path.join(__dirname, 'mcp_kb_index.json');
const TOKEN_FILE = path.join(__dirname, 'mcp_mobile_token.txt');
const SENSE_DIR = path.join(__dirname, 'mcp_senses');
const PORT = 8131;
try { fs.rmSync(DATA, { force: true }); } catch (e) { /* ignore */ }
try { fs.rmSync(KB_INDEX, { force: true }); } catch (e) { /* ignore */ }
try { fs.rmSync(KB_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
try { fs.rmSync(TOKEN_FILE, { force: true }); } catch (e) { /* ignore */ }
try { fs.rmSync(SENSE_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
fs.mkdirSync(KB_DIR, { recursive: true });

const child = spawn(process.execPath, [path.join(ROOT, 'dsh', 'mcp-hippocampus.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    HIPPOCAMPUS_DATA: DATA,
    HIPPOCAMPUS_HTTP_PORT: String(PORT),
    HIPPOCAMPUS_KB_DIR: KB_DIR,
    HIPPOCAMPUS_KB_INDEX: KB_INDEX,
    HIPPOCAMPUS_TOKEN_FILE: TOKEN_FILE,
    HIPPOCAMPUS_SENSE_DIR: SENSE_DIR
  }),
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
const pending = new Map();
const logs = [];
let seq = 0;
let badLines = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { badLines++; logs.push('BAD ' + line); continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => logs.push(d.trim()));

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 8000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (t += d));
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(new Error(t)); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(600);
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'hippocampus-test', version: '0.1.0' }
  });
  notify('notifications/initialized', {});
  const tools = await request('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);

  const stats = await request('tools/call', { name: 'memory_stats', arguments: {} });
  const statsObj = JSON.parse(stats.result.content[0].text);

  const add = await request('tools/call', {
    name: 'memory_add',
    arguments: {
      title: '用傅里叶变换给心电信号降噪',
      summary: '把手机录到的心音做频域滤波，去掉环境噪声后再做峰值检测。',
      domain: 'project',
      tags: ['傅里叶', '降噪', '信号'],
      importance: 0.8,
      auto_link: true
    }
  });
  const addObj = JSON.parse(add.result.content[0].text);

  const recall = await request('tools/call', {
    name: 'memory_recall',
    arguments: { query: '傅里叶 降噪', limit: 5 }
  });
  const recallObj = JSON.parse(recall.result.content[0].text);

  const link = await request('tools/call', {
    name: 'memory_link',
    arguments: { a_id: addObj.id, b_id: 'n_heap', reason: '测试', kind: 'assoc' }
  }).catch((e) => ({ error: e.message }));

  const health = await getJson('http://127.0.0.1:' + PORT + '/api/health');
  const state = await getJson('http://127.0.0.1:' + PORT + '/api/state');

  console.log(JSON.stringify({
    protocol: init.result.protocolVersion,
    server: init.result.serverInfo,
    instructions: String(init.result.instructions || '').slice(0, 60),
    tools: names,
    stats: { nodes: statsObj.nodes, synapses: statsObj.synapses, bridges: statsObj.bridges, avg: statsObj.average_retrievability },
    added: addObj.id,
    proposals: addObj.proposals,
    linked: addObj.linked,
    recall: recallObj.results.map((r) => ({ title: r.title, r: r.retrievability, score: r.relevance })),
    strengthened: recallObj.strengthened,
    linkBadNodeError: !!(link && link.result && link.result.isError),
    health,
    stateNodes: state.nodes.length,
    badStdoutLines: badLines,
    stderr: logs.filter(Boolean).slice(-4)
  }, null, 2));

  child.stdin.end();
  await sleep(200);
  child.kill();
  try { fs.rmSync(DATA, { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(KB_INDEX, { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(KB_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(SENSE_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
})().catch((e) => {
  console.error('TEST FAILED', e);
  console.error(logs.filter(Boolean).slice(-10));
  try { child.kill(); } catch (err) { /* ignore */ }
  process.exit(1);
});
