'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) {
        return item.address;
      }
    }
  }
  return null;
}

const ip = lanIp();
if (!ip) {
  console.log('PHONE LAN TEST SKIPPED: no LAN IPv4');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, 'phone-lan-tmp');
const PORT = 8135;
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'knowledge'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'dsh', 'mcp-hippocampus.js'), '--http-only'], {
  env: Object.assign({}, process.env, {
    HIPPOCAMPUS_HTTP_PORT: String(PORT),
    HIPPOCAMPUS_HOST: '0.0.0.0',
    HIPPOCAMPUS_DATA: path.join(ROOT, 'data', 'brain.json'),
    HIPPOCAMPUS_KB_DIR: path.join(ROOT, 'knowledge'),
    HIPPOCAMPUS_KB_INDEX: path.join(ROOT, 'data', 'kb-index.json')
  }),
  stdio: 'ignore',
  windowsHide: true
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = 'http://127.0.0.1:' + PORT;
const lan = 'http://' + ip + ':' + PORT;

(async () => {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(local + '/api/health');
      if (r.ok) { up = true; break; }
    } catch (e) { /* retry */ }
    await sleep(150);
  }
  if (!up) throw new Error('temp server did not start');

  const info = await fetch(local + '/api/mobile-info').then((r) => r.json());
  const token = info.token;

  const page = await fetch(lan + '/m');
  const state = await fetch(lan + '/api/state');
  const pingNoToken = await fetch(lan + '/api/sense/ping');
  const pingToken = await fetch(lan + '/api/sense/ping?token=' + encodeURIComponent(token));
  const mobileInfo = await fetch(lan + '/api/mobile-info');

  console.log(JSON.stringify({
    ip,
    page: page.status,
    state: state.status,
    pingNoToken: pingNoToken.status,
    pingToken: pingToken.status,
    mobileInfo: mobileInfo.status
  }, null, 2));

  if (page.status !== 200) throw new Error('LAN page should be 200');
  if (state.status !== 403) throw new Error('LAN state should be 403');
  if (pingNoToken.status !== 401) throw new Error('LAN ping without token should be 401');
  if (pingToken.status !== 200) throw new Error('LAN ping with token should be 200');
  if (mobileInfo.status !== 403) throw new Error('LAN mobile-info should be 403');
  console.log('PHONE LAN TEST OK');
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exitCode = 1;
}).finally(async () => {
  child.kill();
  await sleep(400);
  fs.rmSync(ROOT, { recursive: true, force: true });
});
