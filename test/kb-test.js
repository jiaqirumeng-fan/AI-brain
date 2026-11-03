'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { MemoryService } = require('../dsh/memory-service.js');
const { KnowledgeBase } = require('../dsh/knowledge-base.js');

const ROOT = path.resolve(__dirname, 'tmp-kb');
const KB = path.join(ROOT, 'knowledge');
const DATA = path.join(ROOT, 'data');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(KB, '高等数学'), { recursive: true });
fs.mkdirSync(path.join(KB, '项目'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

fs.writeFileSync(path.join(KB, '高等数学', '极限.md'), [
  '---',
  'tags: [极限, 连续]',
  'importance: 0.6',
  '---',
  '# 极限与连续',
  '',
  '函数极限描述自变量趋近某点时函数值的趋势。',
  '连续要求极限存在且等于函数值。',
  ''
].join('\n'), 'utf8');

fs.writeFileSync(path.join(KB, '项目', '答辩.md'), [
  '# 答辩结构',
  '',
  '问题、洞察、证据、边界四段式。评委更关心设计是否成立，而不是技术堆栈。',
  ''
].join('\n'), 'utf8');

const py = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
const docx = path.join(KB, '项目', '机器学习.docx');
const made = spawnSync(py, [path.join(__dirname, 'make-docx.py'), docx], { encoding: 'utf8' });
if (made.status !== 0) {
  console.error('make docx failed', made.stderr);
  process.exit(1);
}

const svc = new MemoryService({ dataFile: path.join(DATA, 'brain.json') });
const kb = new KnowledgeBase({ service: svc, dir: KB, indexFile: path.join(DATA, 'kb-index.json'), log: (m) => console.log('[kb] ' + m) });

const first = kb.scan('test');
console.log('SCAN1', JSON.stringify(first));
console.log('NODES', svc.snapshot().nodes.length);
console.log(svc.snapshot().nodes.slice(-5).map((n) => ({
  title: n.title,
  domain: n.domain,
  tags: n.tags,
  source: n.source && n.source.path,
  chunk: n.source && n.source.chunk,
  text: (n.summary || '').slice(0, 30)
})));

const up = kb.upload(Buffer.from('# 傅里叶变换\n\n把信号拆成不同频率的正弦波，频域里做降噪最直接。\n', 'utf8'), '傅里叶变换.md', '高等数学');
console.log('UPLOAD', JSON.stringify({ file: up.file, added: up.added, title: up.title, nodes: svc.snapshot().nodes.length }));

const second = kb.scan('test2');
console.log('SCAN2', JSON.stringify(second));

fs.appendFileSync(path.join(KB, '高等数学', '极限.md'), '\n补充：洛必达法则适用于 0/0 或 ∞/∞ 型极限。\n', 'utf8');
const third = kb.scan('test3');
console.log('SCAN3', JSON.stringify(third));
console.log('LIMIT NODES', svc.snapshot().nodes.filter((n) => (n.title || '').indexOf('极限') >= 0).map((n) => ({
  title: n.title,
  chunk: n.source && n.source.chunk,
  text: (n.summary || '').slice(-24)
})));

fs.rmSync(path.join(KB, '项目', '答辩.md'), { force: true });
const fourth = kb.scan('test4');
console.log('SCAN4', JSON.stringify(fourth));
console.log('STATUS', JSON.stringify(kb.status()));
fs.rmSync(ROOT, { recursive: true, force: true });
