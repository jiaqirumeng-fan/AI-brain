'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, 'api-add-tmp');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'knowledge'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'dsh', 'mcp-hippocampus.js'), '--http-only'], {
  env: Object.assign({}, process.env, {
    HIPPOCAMPUS_HTTP_PORT: '8132',
    HIPPOCAMPUS_DATA: path.join(ROOT, 'data', 'brain.json'),
    HIPPOCAMPUS_KB_DIR: path.join(ROOT, 'knowledge'),
    HIPPOCAMPUS_KB_INDEX: path.join(ROOT, 'data', 'kb-index.json')
  }),
  stdio: 'ignore',
  windowsHide: true
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:8132';

(async () => {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) { up = true; break; }
    } catch (e) { /* retry */ }
    await sleep(150);
  }
  if (!up) throw new Error('temp server did not start');

  const payload = {
    title: 'API add 端到端测试',
    summary: '验证 /api/add 能写入节点、自动联想并返回 duplicate 标记。',
    domain: '学习科学',
    tags: ['测试', 'API'],
    importance: 0.5,
    auto_link: true,
    source: { kind: 'test' }
  };
  const r1 = await fetch(base + '/api/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d1 = await r1.json();
  const r2 = await fetch(base + '/api/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d2 = await r2.json();
  const state = await fetch(base + '/api/state').then((r) => r.json());
  const node = state.nodes.find((n) => n.title === payload.title);
  console.log(JSON.stringify({ first: d1, second: d2, stateNodes: state.nodes.length, node: node && { id: node.id, source: node.source } }, null, 2));
  if (!d1.ok || !d1.id || !node) throw new Error('add failed');
  if (!d2.duplicate) throw new Error('duplicate not detected');
  console.log('API ADD TEST OK');
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exitCode = 1;
}).finally(async () => {
  child.kill();
  await sleep(400);
  fs.rmSync(ROOT, { recursive: true, force: true });
});
