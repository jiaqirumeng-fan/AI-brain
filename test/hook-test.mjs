import assert from 'node:assert/strict';
import { extractMemory } from '../dsh/plugin/index.js';

const longAnswer = (
  '知识库会按标题和段落切块，每块写成一个记忆节点，并自动连接到相关概念。' +
  '这样文件不是附件，而是和对话共享同一套衰减、突触与复习规则。' +
  '如果文件被修改，系统会移除旧节点、重新切块；如果删除文件，对应节点也会消失。' +
  '这让知识库既是一个文件夹，也是大脑的一部分。'
).repeat(2);

const explicit = extractMemory('记住：知识库文件改动会自动重新入库。', '好的，已经记下。');
assert.ok(explicit, 'explicit remember should be captured');
assert.equal(explicit.kind, 'remember');
assert.equal(explicit.title, '知识库文件改动会自动重新入库');
assert.ok(explicit.tags.includes('知识库'));
assert.equal(explicit.domain, '计算机 · AI');

const qa = extractMemory('为什么知识库要按标题切块？', longAnswer);
assert.ok(qa, 'substantive question should be captured');
assert.equal(qa.kind, 'qa');
assert.equal(qa.title, '为什么知识库要按标题切块');
assert.ok(qa.summary.length > 200);
assert.equal(qa.domain, '计算机 · AI');

const filler = extractMemory('继续', longAnswer);
assert.equal(filler, null, 'filler should be skipped');

const greeting = extractMemory('你好', longAnswer);
assert.equal(greeting, null, 'greeting should be skipped');

const decision = extractMemory('我们决定采用共享记忆服务作为唯一数据源。', longAnswer);
assert.ok(decision, 'decision should be captured');
assert.equal(decision.kind, 'decision');
assert.equal(decision.domain, '计算机 · AI');

const math = extractMemory('极限的 ε-δ 定义怎么理解？', longAnswer);
assert.ok(math);
assert.equal(math.domain, '高等数学');
assert.ok(math.tags.includes('极限'));

console.log(JSON.stringify({ explicit, qa, decision, math, filler, greeting }, null, 2));
console.log('HOOK TEST OK');
