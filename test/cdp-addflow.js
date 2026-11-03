/* 走一遍「添加记忆 → 自动联想 → 建立突触 → 编辑 → 删除」 */
const PORT = process.env.CDP_PORT || 9333;
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch('http://127.0.0.1:' + PORT + '/json').then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.url.indexOf('127.0.0.1:8123') >= 0);
      if (page) return page;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  throw new Error('no page target');
}

async function main() {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  let seq = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await sleep(900);
  const out = {};

  out.open = await evaluate(`(() => { document.querySelector('#btnAdd').click(); return !!document.querySelector('#fTitle'); })()`);
  out.fill = await evaluate(`(() => {
    const set = (id, v) => { const el = document.querySelector(id); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
    set('#fTitle', '用傅里叶变换给心电信号降噪');
    set('#fDomain', 'project');
    set('#fTags', '傅里叶, 降噪, 信号');
    set('#fSummary', '把手机录到的心音做频域滤波，去掉环境噪声后再做峰值检测。');
    set('#fImp', '0.8');
    return document.querySelector('#fDomain').value;
  })()`);
  out.before = await evaluate(`Hippocampus.state().nodes.length`);
  await evaluate(`document.querySelector('#mSave').click()`);
  await sleep(1400);
  out.afterAdd = await evaluate(`Hippocampus.state().nodes.length`);
  out.detail = await evaluate(`document.querySelector('.d-title') ? document.querySelector('.d-title').textContent : ''`);
  out.autoModal = await evaluate(`(() => {
    const h = document.querySelector('.modal h3');
    return { heading: h ? h.textContent : '', rows: document.querySelectorAll('.proposal').length };
  })()`);
  out.connect = await evaluate(`(() => {
    const b = document.querySelector('.proposal button[data-connect]');
    if (!b) return 'none';
    const before = Hippocampus.state().synapses.length;
    b.click();
    return { before, after: Hippocampus.state().synapses.length };
  })()`);
  await sleep(300);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('D:/软件创新大赛/test/flow_auto.png', Buffer.from(shot.result.data, 'base64'));

  // 关闭弹窗 → 编辑标题
  await evaluate(`document.querySelector('.m-close').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('[data-act="edit"]').click()`);
  await sleep(300);
  out.editOpen = await evaluate(`(() => {
    const el = document.querySelector('#fTitle');
    if (!el) return 'no form';
    el.value = '心音降噪：傅里叶 + 带通滤波';
    document.querySelector('#mSave').click();
    return 'edited';
  })()`);
  await sleep(400);
  out.editedTitle = await evaluate(`document.querySelector('.d-title') ? document.querySelector('.d-title').textContent : ''`);

  // 删除
  await evaluate(`document.querySelector('[data-act="delete"]').click()`);
  await sleep(300);
  out.delDialog = await evaluate(`!!document.querySelector('#mDelete')`);
  await evaluate(`document.querySelector('#mDelete').click()`);
  await sleep(400);
  out.afterDelete = await evaluate(`({ nodes: Hippocampus.state().nodes.length, detail: document.querySelector('#detail').classList.contains('open') })`);

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
