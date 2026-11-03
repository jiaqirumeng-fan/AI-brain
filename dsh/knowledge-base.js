'use strict';
/* 海马体 · 知识库
 *
 * 用户把文件放进 knowledge/（或从脑图拖拽上传），这里负责：
 *   解析 → 按标题/段落切块 → 写入记忆节点 → 自动联想 → SSE 广播
 *
 * 支持：.md .markdown .txt .json .docx .pptx .xlsx .pdf .png .jpg .jpeg .webp
 * 文本提取用 Python（docx/pptx/xlsx 用 DSH 自带 Python；pdf 用 dsh/vendor 里的 pypdf）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json']);
const DOC_EXT = new Set(['.docx', '.pptx', '.xlsx', '.pdf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SUPPORTED = new Set([...TEXT_EXT, ...DOC_EXT, ...IMAGE_EXT]);
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_CHUNK = 1400;
const MAX_CHUNKS = 40;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function cleanName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return base || 'file';
}

function parseFrontMatter(text) {
  const meta = {};
  if (!text.startsWith('---')) return { meta, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta, body: text };
  const raw = text.slice(3, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    } else if (/^\d+(\.\d+)?$/.test(value)) {
      value = Number(value);
    }
    meta[key] = value;
  }
  return { meta, body };
}

function pythonCandidates() {
  const list = [];
  if (process.env.HIPPOCAMPUS_PYTHON) list.push(process.env.HIPPOCAMPUS_PYTHON);
  const bundled = path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
  if (fs.existsSync(bundled)) list.push(bundled);
  list.push('python', 'py');
  return list;
}

function runPython(script, args) {
  const vendor = path.join(__dirname, 'vendor', 'python');
  const oldPath = process.env.PYTHONPATH || '';
  const env = Object.assign({}, process.env, {
    PYTHONPATH: vendor + (oldPath ? path.delimiter + oldPath : ''),
    PYTHONIOENCODING: 'utf-8'
  });
  let lastError = null;
  for (const exe of pythonCandidates()) {
    const res = spawnSync(exe, [script, ...args], {
      env,
      encoding: 'utf8',
      timeout: 90 * 1000,
      windowsHide: true
    });
    if (res.error) { lastError = res.error; continue; }
    if (res.status !== 0) { lastError = new Error((res.stderr || '').trim() || ('python exit ' + res.status)); continue; }
    try {
      return JSON.parse((res.stdout || '').trim());
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error('文档解析失败：' + (lastError && lastError.message ? lastError.message : '没有可用的 Python'));
}

function chunkText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let title = '';
  let buf = [];
  const push = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ title, text: body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      push();
      title = m[2];
    } else {
      buf.push(line);
    }
  }
  push();
  if (!sections.length) sections.push({ title: '', text: String(text || '').trim() });

  const out = [];
  for (const section of sections) {
    let body = section.text;
    if (body.length <= MAX_CHUNK) {
      out.push({ title: section.title, text: body });
      continue;
    }
    const paragraphs = body.split(/\n{2,}/);
    let cur = '';
    for (const p of paragraphs) {
      if (!p.trim()) continue;
      if (p.length > MAX_CHUNK) {
        if (cur) { out.push({ title: section.title, text: cur }); cur = ''; }
        for (let i = 0; i < p.length; i += MAX_CHUNK) out.push({ title: section.title, text: p.slice(i, i + MAX_CHUNK) });
        continue;
      }
      const next = cur ? cur + '\n\n' + p : p;
      if (next.length > MAX_CHUNK) {
        out.push({ title: section.title, text: cur });
        cur = p;
      } else {
        cur = next;
      }
    }
    if (cur) out.push({ title: section.title, text: cur });
  }
  return out.filter((c) => c.text.trim()).slice(0, MAX_CHUNKS);
}

function titleOf(text, fallback) {
  const m = /^#\s+(.+)$/m.exec(String(text || ''));
  if (m) return m[1].trim().slice(0, 60);
  return String(fallback || '未命名资料').slice(0, 60);
}

class KnowledgeBase {
  constructor(opts) {
    this.service = opts.service;
    this.root = opts.root || path.resolve(__dirname, '..');
    this.dir = opts.dir || process.env.HIPPOCAMPUS_KB_DIR || path.join(this.root, 'knowledge');
    this.indexFile = opts.indexFile || process.env.HIPPOCAMPUS_KB_INDEX || path.join(this.root, 'data', 'kb-index.json');
    this.log = opts.log || ((msg) => console.error('[knowledge] ' + msg));
    this.index = { version: 1, files: {}, updatedAt: 0 };
    this.lastScan = null;
    this.lastErrors = [];
    this.scanning = false;
    this.watcher = null;
    this.timer = null;
    this.debounce = null;
    this.loadIndex();
  }

  loadIndex() {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (data && data.files) this.index = data;
    } catch (e) { /* first run */ }
  }

  saveIndex() {
    try {
      fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
      this.index.updatedAt = Date.now();
      const tmp = this.indexFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf8');
      try { fs.renameSync(tmp, this.indexFile); } catch (e) { fs.copyFileSync(tmp, this.indexFile); fs.rmSync(tmp, { force: true }); }
    } catch (e) {
      this.log('索引写入失败：' + e.message);
    }
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(path.join(this.dir, '收件箱'), { recursive: true });
    const readme = path.join(this.dir, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        '# 知识库',
        '',
        '把资料放进这个文件夹，海马体会自动切块、入库、建立联想。',
        '',
        '- 子文件夹名 = 领域名，例如 `knowledge/高等数学/极限.md`',
        '- 也可以在文件开头写 front matter：',
        '  ```',
        '  ---',
        '  domain: 高等数学',
        '  tags: [极限, 连续]',
        '  importance: 0.6',
        '  ---',
        '  ```',
        '- 支持：.md .txt .json .docx .pptx .xlsx .pdf .png .jpg',
        '- 图片暂不做 OCR，会作为视觉资料收录。',
        ''
      ].join('\n'), 'utf8');
    }
  }

  start() {
    this.ensureDir();
    if (!this.watcher) {
      try {
        this.watcher = fs.watch(this.dir, { recursive: true }, () => this.schedule());
        this.watcher.on('error', (e) => this.log('文件监听失败：' + e.message));
      } catch (e) {
        this.log('文件监听不可用，改为轮询：' + e.message);
      }
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.scan('interval'), 30 * 1000);
      this.timer.unref();
    }
    setImmediate(() => this.scan('startup'));
  }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.scan('watch'), 1200);
  }

  walk(dir) {
    const out = [];
    const walkOne = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walkOne(full);
        else if (e.isFile()) out.push(full);
      }
    };
    walkOne(dir);
    return out;
  }

  domainFor(rel, meta, override) {
    if (override) return override;
    if (meta.domain) return meta.domain;
    const dir = path.dirname(rel);
    if (dir && dir !== '.' && !/^收件箱([\\/]|$)/.test(dir)) {
      const first = dir.split(/[\\/]/)[0];
      if (first) return first;
    }
    return '学习科学';
  }

  extract(file) {
    const ext = path.extname(file).toLowerCase();
    if (TEXT_EXT.has(ext)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = parseFrontMatter(raw);
      return { text: parsed.body, meta: parsed.meta, title: titleOf(parsed.body, path.basename(file, ext)) };
    }
    if (DOC_EXT.has(ext)) {
      const out = runPython(path.join(__dirname, 'extract_text.py'), [file]);
      if (out && out.error) throw new Error(out.error);
      const text = (out && out.text) || '';
      const parsed = parseFrontMatter(text);
      return { text: parsed.body, meta: parsed.meta, title: out.title || titleOf(parsed.body, path.basename(file, ext)) };
    }
    if (IMAGE_EXT.has(ext)) {
      return { text: '', meta: {}, image: true, title: path.basename(file, ext) };
    }
    throw new Error('不支持的文件类型：' + ext);
  }

  removeFileNodes(rel) {
    const entry = this.index.files[rel];
    if (entry && Array.isArray(entry.nodeIds) && entry.nodeIds.length) {
      this.service.removeNodes(entry.nodeIds, { file: rel });
    }
    delete this.index.files[rel];
  }

  ingest(file, opts) {
    opts = opts || {};
    const rel = path.relative(this.dir, file).replace(/\\/g, '/');
    if (path.basename(rel).toLowerCase() === 'readme.md' && rel === 'README.md') {
      return { skipped: true, ignored: true, reason: 'readme' };
    }
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件过大（>30MB）：' + rel);
    const buf = fs.readFileSync(file);
    const hash = sha256(buf);
    const old = this.index.files[rel];
    if (old && old.hash === hash && (!opts.force)) {
      return { skipped: true, reason: 'unchanged', nodes: old.nodeIds ? old.nodeIds.length : 0 };
    }

    const ext = path.extname(file).toLowerCase();
    let parsed;
    try {
      parsed = this.extract(file);
    } catch (e) {
      throw new Error(rel + '：' + e.message);
    }
    const docTitle = String(parsed.title || path.basename(file, ext)).slice(0, 60);
    const domain = this.domainFor(rel, parsed.meta || {}, opts.domain);
    const baseTags = []
      .concat(Array.isArray(parsed.meta && parsed.meta.tags) ? parsed.meta.tags : [])
      .concat([path.basename(file, ext)])
      .filter(Boolean)
      .map((t) => String(t).trim())
      .filter(Boolean);

    if (old && Array.isArray(old.nodeIds) && old.nodeIds.length) {
      this.service.removeNodes(old.nodeIds, { file: rel });
    }

    const nodeIds = [];
    if (parsed.image) {
      const out = this.service.add({
        title: docTitle,
        summary: '图片资料：' + path.basename(file) + '。已收录为视觉参考；暂未做 OCR。',
        domain,
        tags: baseTags.concat(['图片']).slice(0, 8),
        importance: 0.5,
        auto_link: true,
        source: { kind: 'file', path: rel, chunk: 1, of: 1, hash, image: true }
      }, { defer: true });
      if (!out.duplicate) nodeIds.push(out.node.id);
    } else {
      const chunks = chunkText(parsed.text || '');
      const importance = Number(parsed.meta && parsed.meta.importance);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const heading = chunk.title && chunk.title !== docTitle ? chunk.title : '';
        const title = (heading ? docTitle + ' · ' + heading : (chunks.length > 1 ? docTitle + ' · ' + (i + 1) : docTitle)).slice(0, 60);
        const tags = baseTags.concat(heading ? heading.split(/[\s·、,，]+/).filter(Boolean).slice(0, 3) : [])
          .concat([this.service.domainOf(domain) ? this.service.domainOf(domain).name : ''])
          .filter(Boolean).slice(0, 8);
        const out = this.service.add({
          title,
          summary: chunk.text.slice(0, 1600),
          domain,
          tags,
          importance: Number.isFinite(importance) ? importance : 0.55,
          auto_link: true,
          source: { kind: 'file', path: rel, chunk: i + 1, of: chunks.length, hash }
        }, { defer: true });
        if (!out.duplicate) nodeIds.push(out.node.id);
      }
    }

    if (nodeIds.length) {
      this.service.commit('kb', { file: rel, title: docTitle, added: nodeIds.length });
    }

    this.index.files[rel] = {
      hash,
      nodeIds,
      title: docTitle,
      size: stat.size,
      mtime: stat.mtimeMs,
      updatedAt: Date.now()
    };
    return { added: nodeIds.length, title: docTitle, domain, chunks: nodeIds.length };
  }

  scan(reason) {
    if (this.scanning) return { busy: true };
    this.scanning = true;
    const started = Date.now();
    const summary = { reason: reason || 'manual', files: 0, added: 0, skipped: 0, removed: 0, errors: [] };
    try {
      this.ensureDir();
      const files = this.walk(this.dir).filter((f) => SUPPORTED.has(path.extname(f).toLowerCase()));
      const seen = new Set();
      for (const file of files) {
        const rel = path.relative(this.dir, file).replace(/\\/g, '/');
        seen.add(rel);
        try {
          const res = this.ingest(file);
          if (res.ignored) { summary.skipped++; continue; }
          this.index.files[rel] = this.index.files[rel] || {};
          if (res.skipped) summary.skipped++;
          else summary.added += res.added || 0;
          summary.files++;
        } catch (e) {
          summary.errors.push(e.message);
          this.lastErrors.push({ at: Date.now(), file: rel, error: e.message });
          if (this.lastErrors.length > 20) this.lastErrors.shift();
          this.log('解析失败：' + e.message);
        }
      }
      for (const rel of Object.keys(this.index.files)) {
        if (!seen.has(rel)) {
          this.removeFileNodes(rel);
          summary.removed++;
        }
      }
      this.saveIndex();
      this.lastScan = { at: Date.now(), ms: Date.now() - started, summary };
      if (summary.added || summary.removed || summary.errors.length) {
        this.log('扫描完成：新增 ' + summary.added + ' 条，移除 ' + summary.removed + ' 个文件，错误 ' + summary.errors.length);
      }
      return summary;
    } finally {
      this.scanning = false;
    }
  }

  upload(buffer, filename, domain) {
    this.ensureDir();
    const name = cleanName(filename);
    const ext = path.extname(name).toLowerCase();
    if (!SUPPORTED.has(ext)) throw new Error('不支持的文件类型：' + ext);
    if (buffer.length > MAX_FILE_BYTES) throw new Error('文件过大（>30MB）');
    const dir = path.join(this.dir, '收件箱');
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const stem = path.basename(name, ext);
      target = path.join(dir, stem + '-' + Date.now().toString(36) + ext);
    }
    fs.writeFileSync(target, buffer);
    const res = this.ingest(target, { domain: domain || undefined });
    this.saveIndex();
    return Object.assign({ file: path.relative(this.dir, target).replace(/\\/g, '/') }, res);
  }

  status() {
    const files = Object.keys(this.index.files).filter((rel) => this.index.files[rel].hash);
    const nodeCount = files.reduce((n, rel) => n + ((this.index.files[rel].nodeIds || []).length), 0);
    return {
      dir: this.dir,
      files: files.length,
      nodes: nodeCount,
      lastScan: this.lastScan,
      errors: this.lastErrors.slice(-5),
      recent: files.slice(-12).map((rel) => ({
        path: rel,
        title: this.index.files[rel].title || path.basename(rel),
        nodes: (this.index.files[rel].nodeIds || []).length,
        updatedAt: this.index.files[rel].updatedAt || null
      }))
    };
  }
}

module.exports = { KnowledgeBase, SUPPORTED };
