#!/usr/bin/env node
/* 把「海马体 turn/end 兜底钩子」接进 DSH profile。
 *
 * 用法：
 *   node dsh/install-hook.mjs              # 安装到所有存在的 profile
 *   node dsh/install-hook.mjs desktop      # 只装 desktop
 *   node dsh/install-hook.mjs --remove     # 移除
 *
 * 做的事：
 *   1. 把 dsh/plugin 链接到 ~/.dsh/plugins/dsh-hippocampus-hook
 *   2. 链接进 <profile>/node_modules/dsh-hippocampus-hook
 *   3. 在 cordis.patch.yml 追加一条 hippocampus-hook
 *   4. 备份原 cordis.patch.yml
 *
 * 钩子只捕获当前工作区（D:\软件创新大赛）的正常 turn；
 * 模型本轮已经调用 memory_add 时自动跳过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(PROJECT, 'dsh', 'plugin');
const PLUGIN_NAME = 'dsh-hippocampus-hook';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_ROOT = path.join(DSH_HOME, 'profiles');
const PLUGIN_LINK = path.join(DSH_HOME, 'plugins', PLUGIN_NAME);
const MARK_BEGIN = '# === hippocampus hook BEGIN (managed by dsh/install-hook.mjs) ===';
const MARK_END = '# === hippocampus hook END ===';
const ID = 'hippocampus-hook';

const args = process.argv.slice(2);
const removeMode = args.includes('--remove');
const requested = args.filter((a) => !a.startsWith('--'));

function log(msg) {
  console.log('[hippocampus-hook] ' + msg);
}

function block() {
  return [
    MARK_BEGIN,
    '- insert:',
    '    - id: ' + ID,
    '      name: ' + PLUGIN_NAME,
    '      config: {}',
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
  const dest = file + '.bak-hook-' + stamp;
  fs.copyFileSync(file, dest);
  log('备份：' + dest);
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function ensureLink(link, target) {
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) {
      throw new Error('已存在同名非链接路径，未覆盖：' + link);
    }
    if (samePath(fs.realpathSync(link), target)) return false;
    fs.unlinkSync(link);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
  return true;
}

function removeLink(link) {
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) {
      log('跳过非链接路径：' + link);
      return false;
    }
    fs.unlinkSync(link);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function ensurePluginLinks(profileDir) {
  let changed = 0;
  if (ensureLink(PLUGIN_LINK, PLUGIN_DIR)) {
    log('链接：' + PLUGIN_LINK + ' → ' + PLUGIN_DIR);
    changed++;
  }
  const nm = path.join(profileDir, 'node_modules', PLUGIN_NAME);
  if (ensureLink(nm, PLUGIN_DIR)) {
    log('链接：' + nm + ' → ' + PLUGIN_DIR);
    changed++;
  }
  return changed;
}

function installOne(name) {
  const profileDir = path.join(PROFILE_ROOT, name);
  const file = path.join(profileDir, 'cordis.patch.yml');
  let changed = ensurePluginLinks(profileDir);
  let text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (text.includes('id: ' + ID)) {
    log(name + '：patch 里已经有 ' + ID + '，跳过写入');
    return changed > 0;
  }

  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]') lines.splice(first, 1);
  let base = lines.join('\n').replace(/\s+$/, '');
  if (base) base += '\n\n';
  const next = base + block();

  backup(file);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  log(name + '：已写入 ' + ID);
  return true;
}

function removeOne(name) {
  const profileDir = path.join(PROFILE_ROOT, name);
  const file = path.join(profileDir, 'cordis.patch.yml');
  let text = fs.readFileSync(file, 'utf8');
  let changed = 0;
  const start = text.indexOf(MARK_BEGIN);
  const end = text.indexOf(MARK_END);
  if (start >= 0 && end > start) {
    text = text.slice(0, start) + text.slice(end + MARK_END.length);
    backup(file);
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n', 'utf8');
    fs.renameSync(tmp, file);
    log(name + '：已移除 patch 条目');
    changed++;
  } else if (text.includes('id: ' + ID)) {
    log(name + '：找不到托管标记，请手工检查 ' + file);
  }
  if (removeLink(path.join(profileDir, 'node_modules', PLUGIN_NAME))) changed++;
  return changed;
}

const list = profiles();
if (!list.length) {
  console.error('[hippocampus-hook] 没有找到可用的 profile（' + PROFILE_ROOT + '）');
  process.exit(1);
}
if (!fs.existsSync(path.join(PLUGIN_DIR, 'index.js'))) {
  console.error('[hippocampus-hook] 插件不存在：' + PLUGIN_DIR);
  process.exit(1);
}

log('插件：' + PLUGIN_DIR);
log('目标 profile：' + list.join(', '));

let changed = 0;
for (const name of list) {
  try {
    changed += (removeMode ? removeOne(name) : installOne(name)) ? 1 : 0;
  } catch (err) {
    console.error('[hippocampus-hook] ' + name + ' 修改失败：' + (err && err.message ? err.message : err));
  }
}

if (removeMode) {
  removeLink(PLUGIN_LINK);
  log(changed ? '已移除。重启 DSH 后钩子失效。' : '没有需要移除的内容。');
} else if (!changed) {
  log('没有文件被修改。');
} else {
  log('完成。DSH 会热加载 profile 补丁；如果 data/hook.log 没有出现，完全退出 DSH 再启动。');
  log('验证：data/hook.log 里出现 "hook loaded"；之后每轮结束会写 turn 日志。');
}
