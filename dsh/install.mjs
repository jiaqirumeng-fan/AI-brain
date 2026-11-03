#!/usr/bin/env node
/* 把「海马体」MCP server 接入 DSH profile。
 *
 * 用法：
 *   node dsh/install.mjs              # 默认接入 desktop 和 web 两个 profile（存在哪个改哪个）
 *   node dsh/install.mjs desktop      # 只改 desktop
 *   node dsh/install.mjs --remove     # 从所有 profile 移除
 *
 * 做的事：
 *   1. 在 ~/.dsh/profiles/<profile>/cordis.patch.yml 追加一条 @deepseek-ai/dsh-mcp-client
 *   2. 自动备份原文件
 *   3. 不修改 package.json / 不安装依赖（MCP client 是 DSH 内置插件）
 *
 * 重启 DeepSeek Harness 后生效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const SERVER = path.join(PROJECT, 'dsh', 'mcp-hippocampus.js');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_ROOT = path.join(DSH_HOME, 'profiles');
const MARK_BEGIN = '# === hippocampus MCP BEGIN (managed by dsh/install.mjs) ===';
const MARK_END = '# === hippocampus MCP END ===';
const ID = 'mcp-hippocampus';

const args = process.argv.slice(2);
const removeMode = args.includes('--remove');
const requested = args.filter((a) => !a.startsWith('--'));

function log(msg) {
  console.log('[hippocampus] ' + msg);
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function mcpBlock() {
  return [
    MARK_BEGIN,
    '- insert:',
    '    - id: ' + ID,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: hippocampus',
    '        transport: stdio',
    '        command: ' + quote(process.execPath),
    '        args:',
    '          - ' + quote(SERVER),
    '        toolCallTimeoutMs: 60000',
    MARK_END,
    ''
  ].join('\n');
}

function profiles() {
  if (!fs.existsSync(PROFILE_ROOT)) return [];
  const all = fs.readdirSync(PROFILE_ROOT).filter((name) => {
    const dir = path.join(PROFILE_ROOT, name);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
      && fs.existsSync(path.join(dir, 'cordis.patch.yml'));
  });
  if (requested.length) return requested.filter((name) => all.includes(name));
  return all;
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = file + '.bak-hippocampus-' + stamp;
  fs.copyFileSync(file, dest);
  log('备份：' + dest);
}

function installOne(name) {
  const file = path.join(PROFILE_ROOT, name, 'cordis.patch.yml');
  let text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (text.includes('id: ' + ID)) {
    log(name + '：已经接入，跳过');
    return false;
  }

  // 处理空的根数组：[] 后面不能再跟 block 列表
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]') lines.splice(first, 1);
  let base = lines.join('\n').replace(/\s+$/, '');
  if (base) base += '\n\n';
  const next = base + mcpBlock();

  backup(file);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  log(name + '：已写入 mcp-hippocampus');
  return true;
}

function removeOne(name) {
  const file = path.join(PROFILE_ROOT, name, 'cordis.patch.yml');
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes('id: ' + ID)) {
    log(name + '：没有找到 hippocampus 条目，跳过');
    return false;
  }
  const start = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  if (start >= 0 && end > start) {
    text = text.slice(0, start) + text.slice(end + MARK_END.length);
  } else {
    // 兜底：逐行删掉 id 为 mcp-hippocampus 的 insert 块（只在格式被手改过时发生）
    log(name + '：找不到托管标记，请手工检查 ' + file);
    return false;
  }
  backup(file);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n', 'utf8');
  fs.renameSync(tmp, file);
  log(name + '：已移除');
  return true;
}

const list = profiles();
if (!list.length) {
  console.error('[hippocampus] 没有找到可用的 profile（' + PROFILE_ROOT + '）');
  process.exit(1);
}

if (!fs.existsSync(SERVER)) {
  console.error('[hippocampus] MCP server 不存在：' + SERVER);
  process.exit(1);
}

log('使用 Node：' + process.execPath);
log('MCP server：' + SERVER);
log('目标 profile：' + list.join(', '));

let changed = 0;
for (const name of list) {
  try {
    changed += (removeMode ? removeOne(name) : installOne(name)) ? 1 : 0;
  } catch (err) {
    console.error('[hippocampus] ' + name + ' 修改失败：' + (err && err.message ? err.message : err));
  }
}

if (!changed) {
  log('没有文件被修改。');
} else if (removeMode) {
  log('完成。重启 DeepSeek Harness 后，memory_* 工具会消失。');
} else {
  log('完成。现在完全退出 DeepSeek Harness（托盘退出），再启动，新会话里会出现 memory_* 工具。');
  log('脑图：http://127.0.0.1:8130/ （由 MCP server 同时提供，DSH 启动后可用）');
}
