/**
 * DSH turn/end 钩子：对话结束后自动抽取记忆。
 *
 * 它不依赖模型主动调用 memory_add。每轮结束（turn/end）时：
 *   1. 只处理当前工作区、非 subagent、正常完成的 turn；
 *   2. 取本轮最后一条真实用户消息与最后一条有文本的 assistant 消息；
 *   3. 模型本轮已经调用过 memory_add → 跳过（不重复）；
 *   4. 用户明确说“记住” → 一定捕获；
 *   5. 学习型问答 / 项目决策 → 捕获一条摘要；
 *   6. POST 到海马体 /api/add，节点带 source.kind = conversation。
 *
 * 这是启发式抽取（不额外调用 LLM），所以宁少勿滥：
 * 寒暄、继续、工具操作、过短回答都不入库。
 */

import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-hippocampus-hook';

const ROOT = process.env.HIPPOCAMPUS_ROOT || 'D:\\软件创新大赛';
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'hook.log');
const SERVICE_URL = process.env.HIPPOCAMPUS_HTTP_URL || 'http://127.0.0.1:8130';
const WORKSPACE = process.env.HIPPOCAMPUS_WORKSPACE || 'D:\\软件创新大赛';

const seenTurns = new Set();
const seenHashes = new Set();

function log(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + line + '\n', 'utf8');
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function trimSet(set, max) {
  while (set.size > max) {
    const first = set.values().next().value;
    set.delete(first);
  }
}

function textOf(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function isInjected(message) {
  const kind = message && message.source && message.source.kind;
  return kind === 'agent-instructions' || kind === 'runtime-context' ||
    kind === 'system-prompt' || kind === 'hippocampus-hook' || kind === 'hippocampus-memory';
}

function sameWorkspace(cwd) {
  if (!cwd) return false;
  try {
    return path.resolve(cwd).toLowerCase() === path.resolve(WORKSPACE).toLowerCase();
  } catch (e) {
    return false;
  }
}

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstSentence(text, max) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const first = normalized.split(/[。！？!?；;\n]/).map((s) => s.trim()).filter(Boolean)[0] || '';
  return first.replace(/[，,、：:]+$/, '').slice(0, max);
}

function cleanQuestion(text) {
  return String(text || '')
    .replace(/^\s*(请问|请|帮我|麻烦|能不能|可以|我想问|问一下)\s*/, '')
    .replace(/[?？\s]+$/, '')
    .trim();
}

const TAG_GROUPS = [
  ['DSH', 'MCP', 'SSE', '脑图', '知识库', '插件', '钩子', '接口', '算法', '模型', '代码', '程序', '文件', 'PDF', '记忆'],
  ['极限', '导数', '积分', '微分', '级数', '概率', '函数', '连续'],
  ['矩阵', '向量', '特征值', '行列式', '线性变换'],
  ['物理', '力', '能量', '电磁', '热力学', '振动', '波'],
  ['项目', '比赛', '答辩', '评委', '产品', '方案'],
  ['复习', '遗忘', '学习', '记忆曲线', '间隔重复']
];

function tagsFor(text) {
  const tags = [];
  for (const group of TAG_GROUPS) {
    for (const keyword of group) {
      if (text.indexOf(keyword) >= 0 && tags.indexOf(keyword) < 0) tags.push(keyword);
    }
  }
  return tags.slice(0, 4).length ? tags.slice(0, 4) : ['对话'];
}

function inferDomain(text) {
  if (/矩阵|向量|特征值|行列式|线性变换/.test(text)) return '线性代数';
  if (/物理|电磁|热力学|振动|能量守恒/.test(text)) return '大学物理';
  if (/极限|导数|积分|微分|级数|概率|函数/.test(text)) return '高等数学';
  if (/DSH|MCP|SSE|脑图|知识库|插件|钩子|接口|算法|模型|代码|程序|PDF/.test(text)) return '计算机 · AI';
  if (/项目|比赛|答辩|评委|产品|方案/.test(text)) return '项目 · 竞赛';
  if (/复习|遗忘|记忆曲线|间隔重复|学习科学/.test(text)) return '学习科学';
  return '学习科学';
}

/**
 * 纯函数：从一轮对话中判断是否值得记、生成节点字段。
 * 导出是为了单测；不产生任何 I/O。
 */
export function extractMemory(userText, assistantText) {
  const user = clean(userText);
  const answer = clean(assistantText);
  if (!user) return null;

  const remember = /(?:^|[\s，,。；;])(?:请|帮我|麻烦)?\s*(?:记住|记一下|记下来|帮我记|保存到记忆|别忘了)[：:，,\s]*([\s\S]*)$/.exec(user);
  if (remember) {
    let statement = (remember[1] || '').trim();
    if (statement.length < 4) statement = answer.slice(0, 300);
    if (!statement) return null;
    const text = user + '\n' + answer;
    const title = firstSentence(statement, 44);
    if (title.length < 4) return null;
    let summary = statement;
    if (answer && summary.indexOf(answer.slice(0, 60)) < 0) summary += '\n\n' + answer.slice(0, 700);
    return {
      kind: 'remember',
      title,
      summary: summary.slice(0, 1600),
      domain: inferDomain(text),
      tags: tagsFor(text),
      importance: 0.8
    };
  }

  if (answer.length < 240) return null;
  if (user.length < 6 || user.length > 800) return null;
  const isQuestion = /[?？]/.test(user) ||
    /(如何|怎么|为什么|什么|区别|解释|原理|步骤|总结|能否|可以|是否|多少|哪种|有哪些|吗)/.test(user);
  const isDecision = /(决定|方案|结论|以后|采用|实现|完成|修复|部署|配置|安装|改成|注意)/.test(user);
  if (!isQuestion && !isDecision) return null;
  if (!isQuestion && /(继续|运行|测试|截图|打开|修改|执行|重启|删除)/.test(user)) return null;

  const title = firstSentence(cleanQuestion(user), 44);
  if (title.length < 4) return null;
  if (/^(你好|您好|hi|hello|好的|谢谢|继续|在吗)$/i.test(title)) return null;

  const text = user + '\n' + answer;
  return {
    kind: isQuestion ? 'qa' : 'decision',
    title,
    summary: answer.slice(0, 1200),
    domain: inferDomain(text),
    tags: tagsFor(text),
    importance: isQuestion ? 0.55 : 0.65
  };
}

function eventsOfTurn(session, turn, endSeq) {
  const all = session.snapshotEvents();
  let startSeq = 0;
  for (const event of all) {
    if (event.type === 'turn/start' && event.data && event.data.turn === turn && Number(event.seq) <= endSeq) {
      startSeq = Number(event.seq);
    }
  }
  return all.filter((event) => Number(event.seq) >= startSeq && Number(event.seq) <= endSeq);
}

function modelAlreadySaved(events) {
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    try {
      if (JSON.stringify(event.data || {}).indexOf('memory_add') >= 0) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

export async function capture(session, event, options) {
  const serviceUrl = (options && options.serviceUrl) || SERVICE_URL;
  const header = session.header || {};
  if (!sameWorkspace(header.cwd)) return;
  if (header.origin === 'subagent' || (header.delegationDepth || 0) > 0) return;

  const reason = event.data && event.data.reason;
  if (!reason || (reason.kind !== 'completed' && reason.kind !== 'max-tokens')) return;

  const turn = event.data.turn;
  const endSeq = Number(event.seq);
  if (!Number.isFinite(endSeq)) return;

  const events = eventsOfTurn(session, turn, endSeq);
  if (modelAlreadySaved(events)) {
    log('skip turn ' + turn + ': model used memory_add');
    return;
  }

  let userText = '';
  let assistantText = '';
  for (const item of events) {
    if (item.type === 'user/message' && !isInjected(item.data)) {
      const text = textOf(item.data);
      if (text) userText = text;
    } else if (item.type === 'assistant/message') {
      const text = textOf(item.data && item.data.message);
      if (text) assistantText = text;
    }
  }

  const memory = extractMemory(userText, assistantText);
  if (!memory) return;

  const hash = memory.title + '|' + memory.summary.slice(0, 120);
  if (seenHashes.has(hash)) return;

  const payload = {
    title: memory.title,
    summary: memory.summary,
    domain: memory.domain,
    tags: memory.tags,
    importance: memory.importance,
    auto_link: true,
    source: {
      kind: 'conversation',
      session: session.id,
      turn,
      at: Date.now()
    }
  };

  const res = await fetch(serviceUrl + '/api/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
  });
  if (!res.ok) {
    log('http ' + res.status + ' turn ' + turn);
    return;
  }
  const data = await res.json();
  if (data && data.ok && !data.duplicate) {
    seenHashes.add(hash);
    trimSet(seenHashes, 300);
    log('captured turn ' + turn + ' id ' + data.id + ' title ' + memory.title);
  } else {
    log('skip turn ' + turn + ': duplicate');
  }
}

export function apply(ctx) {
  log('hook loaded · workspace=' + WORKSPACE + ' · service=' + SERVICE_URL);
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event || event.type !== 'turn/end') return;
      const key = String(session.id) + ':' + String(event.seq);
      if (seenTurns.has(key)) return;
      seenTurns.add(key);
      trimSet(seenTurns, 400);
      setImmediate(() => {
        capture(session, event).catch((error) => log('capture error: ' + (error && error.message ? error.message : error)));
      });
    } catch (error) {
      log('listener error: ' + (error && error.message ? error.message : error));
    }
  });
}
