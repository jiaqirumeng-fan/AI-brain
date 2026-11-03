/* 用 CDP 驱动一次真实交互，捕获控制台错误 */
const PORT = process.env.CDP_PORT || 9333;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push('LOG: ' + msg.params.entry.text);
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
    if (r.result && r.result.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await sleep(800);

  const out = {};
  out.ready = await evaluate('!!window.Hippocampus');
  out.stats0 = await evaluate('JSON.stringify(Model.stats(Hippocampus.state(), Date.now()))');
  out.nodes0 = await evaluate('Hippocampus.state().nodes.length');
  out.syn0 = await evaluate('Hippocampus.state().synapses.length');

  // 1) 添加记忆
  out.added = await evaluate(`(() => {
    const n = Hippocampus.addMemory({ title: '用傅里叶变换给心电信号降噪', domain: 'project',
      tags: ['傅里叶','降噪','信号'], summary: '把手机录到的心音做频域滤波，去掉环境噪声后再做峰值检测。', importance: 0.8 });
    return { id: n.id, nodes: Hippocampus.state().nodes.length };
  })()`);
  out.proposals = await evaluate(`Hippocampus.proposals({ nodeId: '${out.added.id}', threshold: 0.3, limit: 5 })
    .map(p => ({ s: +p.score.toFixed(2), b: p.b.title, via: p.via.length }))`);

  // 2) 连续回想 → 共激活
  out.recall1 = await evaluate(`Hippocampus.recall('n_fourier'); Hippocampus.state().nodes.find(n=>n.id==='n_fourier').recallCount`);
  out.recall2 = await evaluate(`Hippocampus.recall('n_ebbing'); 1`);
  await sleep(300);
  out.coactSyn = await evaluate(`Hippocampus.state().synapses.filter(s=>s.kind==='coact').length`);
  out.nascent = await evaluate(`Hippocampus.state().synapses.filter(s=>s.nascent).map(s=>s.reason)`);

  // 3) 关联扫描弹窗 + 建立
  await evaluate(`document.querySelector('#btnScan').click()`);
  await sleep(500);
  out.modalOpen = await evaluate(`!!document.querySelector('.modal-backdrop')`);
  out.proposalRows = await evaluate(`document.querySelectorAll('.proposal').length`);
  out.afterConnect = await evaluate(`(() => {
    const btn = document.querySelector('.proposal button[data-connect]');
    if (!btn) return 'no row';
    const before = Hippocampus.state().synapses.length;
    btn.click();
    return { before, after: Hippocampus.state().synapses.length, label: btn.textContent };
  })()`);
  await evaluate(`document.querySelector('.m-close') ? document.querySelector('.m-close').click() : 0`);

  // 4) 画布点击选中节点
  out.canvasClick = await evaluate(`(() => {
    const g = Hippocampus.graph();
    g.fit(60, true);
    const n = Hippocampus.state().nodes.find(x => x.id === 'n_matrix');
    const p = g.worldToScreen(n.x, n.y);
    const c = document.querySelector('#brain');
    const r = c.getBoundingClientRect();
    const opts = { clientX: r.left + p.x, clientY: r.top + p.y, bubbles: true, pointerId: 7, button: 0, isPrimary: true };
    c.dispatchEvent(new PointerEvent('pointerdown', opts));
    window.dispatchEvent(new PointerEvent('pointerup', opts));
    return { clicked: [Math.round(p.x), Math.round(p.y)], open: document.querySelector('#detail').classList.contains('open') };
  })()`);
  await sleep(350);
  out.detailTitle = await evaluate(`document.querySelector('.d-title') ? document.querySelector('.d-title').textContent : ''`);

  // 5) 详情里的回想按钮
  out.detailRecall = await evaluate(`(() => {
    const before = document.querySelector('.strength b').textContent;
    document.querySelector('[data-act="recall"]').click();
    return { before };
  })()`);
  await sleep(300);
  out.detailAfter = await evaluate(`document.querySelector('.strength b') ? document.querySelector('.strength b').textContent : ''`);

  // 6) 时间机器
  out.time = await evaluate(`(() => {
    Hippocampus.timeTravel(90);
    return { value: document.querySelector('#timeValue').textContent, stat: document.querySelector('#statVitality').textContent };
  })()`);
  await sleep(250);
  out.timeStat = await evaluate(`document.querySelector('#statVitality').textContent`);

  // 7) 搜索
  out.search = await evaluate(`(() => {
    const i = document.querySelector('#search');
    i.value = '熵';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#searchCount').textContent;
  })()`);

  // 8) 刷新后数据是否还在
  out.saved = await evaluate(`!!localStorage.getItem('hippocampus.brain.v2')`);
  out.savedNodes = await evaluate(`JSON.parse(localStorage.getItem('hippocampus.brain.v2')).nodes.length`);

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  ws.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
