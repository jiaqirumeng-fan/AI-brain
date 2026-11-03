import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hippocampus-hook-test-' + Date.now());
process.env.HIPPOCAMPUS_ROOT = TMP;
const { capture } = await import('../dsh/plugin/index.js');

const longAnswer = (
  '知识库会按标题和段落切块，每块写成一个记忆节点，并自动连接到相关概念。' +
  '这样文件不是附件，而是和对话共享同一套衰减、突触与复习规则。' +
  '修改文件会移除旧节点并重新切块，删除文件会移除对应节点。'
).repeat(3);

const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id: 'n_test', duplicate: false }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

function makeSession(opts = {}) {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      data: {
        role: 'user',
        content: [{ type: 'text', text: opts.user || '为什么知识库要按标题切块？' }],
        source: { kind: 'user' }
      }
    },
    {
      type: 'assistant/message',
      seq: 3,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: longAnswer }]
        }
      }
    }
  ];
  if (opts.memoryTool) {
    events.push({
      type: 'tool/call',
      seq: 4,
      data: { call: { name: 'mcp__hippocampus__memory_add' } }
    });
  }
  events.push({
    type: 'turn/end',
    seq: 5,
    data: { turn: 1, reason: { kind: opts.reason || 'completed' } }
  });
  return {
    id: opts.id || 's_test',
    header: {
      cwd: opts.cwd || 'D:\\软件创新大赛',
      origin: opts.origin,
      delegationDepth: opts.depth || 0
    },
    snapshotEvents: () => events
  };
}

// 1) 学习问答 → 捕获并发给 /api/add
const qa = makeSession();
await capture(qa, qa.snapshotEvents().at(-1), { serviceUrl: base });
assert.equal(received.length, 1);
assert.equal(received[0].url, '/api/add');
assert.equal(received[0].body.title, '为什么知识库要按标题切块');
assert.equal(received[0].body.source.kind, 'conversation');
assert.equal(received[0].body.source.session, 's_test');
assert.equal(received[0].body.domain, '计算机 · AI');

// 2) 模型本轮已调用 memory_add → 跳过，不发请求
const saved = makeSession({ memoryTool: true, user: '我们决定采用共享记忆服务作为唯一数据源。' });
await capture(saved, saved.snapshotEvents().at(-1), { serviceUrl: base });
assert.equal(received.length, 1);

// 3) subagent → 跳过
const sub = makeSession({ origin: 'subagent', user: '为什么知识库要按标题切块？' });
await capture(sub, sub.snapshotEvents().at(-1), { serviceUrl: base });
assert.equal(received.length, 1);

// 4) 其他工作区 → 跳过
const other = makeSession({ cwd: 'D:\\其他项目', user: '为什么知识库要按标题切块？' });
await capture(other, other.snapshotEvents().at(-1), { serviceUrl: base });
assert.equal(received.length, 1);

// 5) 中断的 turn → 跳过
const aborted = makeSession({ reason: 'aborted', user: '为什么知识库要按标题切块？' });
await capture(aborted, aborted.snapshotEvents().at(-1), { serviceUrl: base });
assert.equal(received.length, 1);

server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(JSON.stringify({ requests: received.length, title: received[0].body.title, source: received[0].body.source }, null, 2));
console.log('HOOK CAPTURE TEST OK');
