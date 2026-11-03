'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, 'phone-tmp');
const PORT = 8134;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'knowledge'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'dsh', 'mcp-hippocampus.js'), '--http-only'], {
  env: Object.assign({}, process.env, {
    HIPPOCAMPUS_HTTP_PORT: String(PORT),
    HIPPOCAMPUS_HOST: '127.0.0.1',
    HIPPOCAMPUS_DATA: path.join(ROOT, 'data', 'brain.json'),
    HIPPOCAMPUS_KB_DIR: path.join(ROOT, 'knowledge'),
    HIPPOCAMPUS_KB_INDEX: path.join(ROOT, 'data', 'kb-index.json')
  }),
  stdio: 'ignore',
  windowsHide: true
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:' + PORT;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3Z8AAAAASUVORK5CYII=', 'base64');

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

  const page = await fetch(base + '/m');
  const html = await page.text();
  if (!page.ok || html.indexOf('手机感官') < 0) throw new Error('mobile page not served');

  const info = await fetch(base + '/api/mobile-info').then((r) => r.json());
  if (!info.ok || !info.token) throw new Error('mobile-info failed');

  const noteRes = await fetch(base + '/api/sense/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '手机测试：今天在课堂上看到一个傅里叶变换的动画。' })
  }).then((r) => r.json());
  if (!noteRes.ok || !noteRes.id) throw new Error('note upload failed');

  const photoRes = await fetch(base + '/api/sense/photo?note=' + encodeURIComponent('白板上的公式') + '&w=1&h=1', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG
  }).then((r) => r.json());
  if (!photoRes.ok || !photoRes.url) throw new Error('photo upload failed');

  const fileRes = await fetch(base + photoRes.url);
  const fileBytes = Buffer.from(await fileRes.arrayBuffer());
  if (!fileRes.ok || fileBytes.length !== PNG.length) throw new Error('photo file read failed');
  const rangeRes = await fetch(base + photoRes.url, { headers: { Range: 'bytes=0-7' } });
  if (rangeRes.status !== 206 || Number(rangeRes.headers.get('content-length')) !== 8) throw new Error('photo range failed');

  const audioRes = await fetch(base + '/api/sense/audio?note=' + encodeURIComponent('一段课堂录音') + '&duration=3.2', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.from('fake-webm-audio')
  }).then((r) => r.json());
  if (!audioRes.ok || !audioRes.url) throw new Error('audio upload failed');

  const recent = await fetch(base + '/api/sense/recent?limit=10').then((r) => r.json());
  if (!recent.ok || recent.results.length !== 3) throw new Error('recent count ' + recent.results.length);

  const state = await fetch(base + '/api/state').then((r) => r.json());
  const senses = state.nodes.filter((n) => n.source && /^phone-/.test(n.source.kind));
  if (senses.length !== 3) throw new Error('state sense count ' + senses.length);
  const photoNode = senses.find((n) => n.source.kind === 'phone-photo');
  if (!photoNode || photoNode.source.width !== 1 || photoNode.source.height !== 1) throw new Error('photo source metadata missing');

  const qr = await fetch(base + '/api/mobile-qr');
  const svg = await qr.text();
  const qrOk = qr.ok && svg.indexOf('<svg') >= 0;
  if (!qrOk) console.log('QR skipped (no LAN or qrcode unavailable)');

  console.log(JSON.stringify({
    page: page.status,
    token: info.token.slice(0, 6) + '…',
    note: noteRes.title,
    photo: photoRes.title,
    audio: audioRes.title,
    recent: recent.results.map((r) => r.kind),
    qr: qrOk ? qr.status : 'skipped',
    nodes: state.nodes.length
  }, null, 2));
  console.log('PHONE TEST OK');
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exitCode = 1;
}).finally(async () => {
  child.kill();
  await sleep(400);
  fs.rmSync(ROOT, { recursive: true, force: true });
});
