/* 海马体 · 应用层 */
(function () {
  'use strict';

  const HU = window.HU;
  const Model = window.Model;
  const Seed = window.Seed;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = HU.escapeHtml;

  const KEY = 'hippocampus.brain.v2';
  const PALETTE = ['#4cc9f0', '#8b7bff', '#ffa94d', '#2fe6a8', '#ff6b9a', '#ffd166', '#a0e57c', '#ff8fab', '#c4a7ff'];

  let state = null;
  let graph = null;
  let selectedId = null;
  let filterDomain = null;
  let searchIds = null;
  let timeOffset = 0;
  let globalView = false;
  let saveTimer = null;
  let activeModal = null;
  let timeRenderTimer = null;
  let sessionRecalls = [];

  const REMOTE_PORT = 8130;
  const REMOTE_BASE = (location.port === String(REMOTE_PORT)) ? '' : 'http://127.0.0.1:' + REMOTE_PORT;
  let remoteMode = false;
  let remoteRev = 0;
  let remoteSource = HU.uid('ui_');
  let remoteEvents = null;
  let remotePullTimer = null;
  let pendingRemote = null;
  let kbLayoutPending = false;
  let forceNextSave = false;

  init().catch((err) => {
    console.error('[hippocampus] init failed', err);
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="position:fixed;z-index:9999;left:16px;top:16px;padding:10px 14px;border:1px solid #ff7187;border-radius:10px;background:#1a0d12;color:#ffd6dd;font:12px/1.5 sans-serif">海马体初始化失败：' +
      HU.escapeHtml(err && err.message ? err.message : String(err)) + '</div>');
  });

  async function init() {
    if (location.search.indexOf('static') >= 0) document.body.classList.add('no-anim');
    const localOnly = location.search.indexOf('local=1') >= 0;
    const remote = localOnly ? null : await loadRemote();
    state = remote ? remote.state : loadState();
    remoteMode = !!remote;
    remoteRev = remote ? remote.rev : 0;
    let seeded = false;
    if (!state) {
      state = Seed.create();
      seeded = true;
    }
    if (!state.settings) state.settings = { threshold: 0.32 };
    if (!Array.isArray(state.synapses)) state.synapses = [];

    graph = new window.BrainGraph($('#brain'), {
      onSelect: (node) => select(node ? node.id : null),
      onRecall: (node) => doRecall(node.id),
      onManualLink: (a, b) => connect(a, b),
      onHover: onHover
    });
    graph.setData(state.nodes, state.synapses, state.domains);
    graph.fit(90, true);
    setTimeout(() => { if (!selectedId) graph.fit(); }, 1200);

    bindUI();
    renderAll();
    paintTimeSlider(0);
    setModeState(remoteMode);
    if (remoteMode) setupRemote();
    if (seeded) save(true);
    $('#saveState').textContent = remoteMode ? '已同步' : '已本地保存';

    setTimeout(() => {
      toast('这是一张会遗忘的记忆网 · 双击节点试试', 'good');
    }, 1100);
    setTimeout(() => $('#hint').classList.add('hide'), 22000);
    setInterval(() => { $('#clock').textContent = HU.fmtClock(Date.now()); }, 30000);

    if (location.search.indexOf('debug') >= 0) {
      setTimeout(() => {
        document.documentElement.dataset.layout = JSON.stringify({
          cam: graph.cam,
          w: graph.w,
          h: graph.h,
          inner: [window.innerWidth, window.innerHeight],
          stage: (() => { const r = $('#stage').getBoundingClientRect(); return [r.width, r.height]; })(),
          canvas: (() => { const r = $('#brain').getBoundingClientRect(); return [r.width, r.height]; })(),
          nodes: state.nodes.map((n) => ({ t: n.title, d: n.domain, x: Math.round(n.x), y: Math.round(n.y) }))
        });
      }, 2500);
    }
    const params = new URLSearchParams(location.search);
    if (params.get('pick')) setTimeout(() => select(params.get('pick'), { focus: true }), 400);
    if (params.get('time')) setTimeout(() => setTimeOffset(+params.get('time')), 400);
    if (params.get('modal') === 'proposals') setTimeout(() => openProposals({ global: true }), 500);
    if (params.get('modal') === 'add') setTimeout(() => openAddModal(), 500);
    if (params.get('modal') === 'help') setTimeout(() => openHelp(), 500);
    if (params.get('global')) setTimeout(() => toggleGlobalView(), 450);
    if (params.get('relayout')) setTimeout(() => relayout(false), 1200);
    if (params.get('recall')) setTimeout(() => doRecall(params.get('recall')), 900);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.nodes) || !Array.isArray(s.domains)) return null;
      if (!Array.isArray(s.synapses)) s.synapses = [];
      return s;
    } catch (e) {
      return null;
    }
  }

  /* ══════════════ DSH 记忆服务（可选） ══════════════ */
  async function loadRemote() {
    if (!window.fetch) return null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1400);
      const health = await fetch(REMOTE_BASE + '/api/health', { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!health.ok) return null;
      const h = await health.json();
      if (!h || !h.ok) return null;
      const sRes = await fetch(REMOTE_BASE + '/api/state', { cache: 'no-store' });
      if (!sRes.ok) return null;
      const s = await sRes.json();
      if (!s || !Array.isArray(s.nodes)) return null;
      return { state: s, rev: Number(s.rev) || Number(h.rev) || 0 };
    } catch (e) {
      return null;
    }
  }

  function setupRemote() {
    setModeState(true);
    try {
      remoteEvents = new EventSource(REMOTE_BASE + '/api/events');
      const handler = (e) => {
        try { onRemoteEvent(JSON.parse(e.data)); } catch (err) { /* ignore */ }
      };
      remoteEvents.addEventListener('state', handler);
      remoteEvents.onmessage = handler;
    } catch (e) {
      remoteEvents = null;
    }
    setInterval(() => {
      if (!remoteEvents || remoteEvents.readyState !== 1) pullRemote();
    }, 9000);
  }

  function onRemoteEvent(ev) {
    if (!ev || ev.source === remoteSource) return;
    if (ev.type === 'recall' && Array.isArray(ev.ids)) {
      let pulsing = 0;
      for (const id of ev.ids) {
        if (graph.nodeMap.get(id)) {
          graph.pulseFrom(id);
          graph.floater(id, 'DSH 调用了这条记忆');
          pulsing++;
        }
      }
      if (pulsing) toast('DSH 正在调用记忆 · ' + pulsing + ' 条被强化', 'bridge');
    } else if (ev.type === 'add') {
      let prefix = 'DSH 记住了：';
      if (ev.source === 'conversation') prefix = '自动记住了：';
      else if (ev.source === 'phone-photo') prefix = '手机送来一张照片：';
      else if (ev.source === 'phone-audio') prefix = '手机送来一段录音：';
      else if (ev.source === 'phone-note') prefix = '手机送来一条文字：';
      toast(prefix + (ev.node || '一条新记忆'), 'good');
    } else if (ev.type === 'link') {
      toast('DSH 建立了一条新突触', 'bridge');
    } else if (ev.type === 'kb') {
      kbLayoutPending = true;
      toast('知识库新增 ' + (ev.added || 0) + ' 条 · ' + (ev.title || ev.file || ''), 'good');
    } else if (ev.type === 'kb-remove') {
      toast('知识库移除了 ' + (ev.file || '一个文件'), 'warn');
    }
    clearTimeout(remotePullTimer);
    remotePullTimer = setTimeout(pullRemote, 140);
  }

  async function pullRemote() {
    if (!remoteMode) return;
    try {
      const r = await fetch(REMOTE_BASE + '/api/state', { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      if (!s || !Array.isArray(s.nodes)) return;
      const rev = Number(s.rev) || 0;
      if (rev <= remoteRev) return;
      if (activeModal || (graph && graph.pointer && graph.pointer.down)) {
        pendingRemote = s;
        return;
      }
      applyRemote(s, rev, kbLayoutPending);
      kbLayoutPending = false;
    } catch (e) { /* offline */ }
  }

  function applyRemote(s, rev, settle) {
    const before = new Set(state.nodes.map((n) => n.id));
    state = s;
    remoteRev = rev;
    if (selectedId && !Model.findNode(state, selectedId)) selectedId = null;
    graph.setData(state.nodes, state.synapses, state.domains, { settle: !!settle });
    graph.setSelected(selectedId);
    if (searchIds) applySearch($('#search').value);
    renderAll();
    if (settle) graph.fit(72);
    const added = state.nodes.filter((n) => !before.has(n.id));
    if (added.length && graph.nodeMap.get(added[0].id)) graph.floater(added[0].id, '新记忆入库', 'bridge');
  }

  function flushPendingRemote() {
    if (!pendingRemote || activeModal) return;
    const s = pendingRemote;
    pendingRemote = null;
    if (Number(s.rev) > remoteRev) {
      applyRemote(s, Number(s.rev), kbLayoutPending);
      kbLayoutPending = false;
    }
  }

  function setModeState(on) {
    const el = $('#modeState');
    if (!el) return;
    el.textContent = on ? 'DSH 已连接' : '本地模式';
    el.classList.toggle('on', !!on);
    el.title = on ? '记忆与 DSH 海马体服务实时同步' : '数据只保存在这台电脑的浏览器里';
  }

  function save(immediate) {
    clearTimeout(saveTimer);
    if (immediate) {
      persistNow();
      return;
    }
    setSaveState('saving');
    saveTimer = setTimeout(persistNow, 340);
  }

  function persistNow() {
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) { /* quota / file:// */ }

    if (!remoteMode) {
      setSaveState('saved');
      return;
    }

    const force = forceNextSave;
    forceNextSave = false;
    setSaveState('saving');
    fetch(REMOTE_BASE + '/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: state, baseRev: remoteRev, source: remoteSource, force: force })
    }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) {
        setSaveState('error');
        return;
      }
      remoteRev = Number(d.rev) || remoteRev;
      setSaveState('saved');
      if (d.merged && d.state) applyRemote(d.state, Number(d.state.rev) || remoteRev);
    }).catch(() => setSaveState('error'));
  }

  function setSaveState(kind) {
    const dot = $('#saveDot');
    const label = $('#saveState');
    if (!dot || !label) return;
    if (kind === 'saving') {
      dot.classList.add('saving');
      label.textContent = '正在同步…';
    } else if (kind === 'error') {
      dot.classList.remove('saving');
      dot.style.background = '#ff7187';
      label.textContent = '同步失败';
    } else {
      dot.classList.remove('saving');
      dot.style.background = '';
      label.textContent = (remoteMode ? '已同步 · ' : '已保存 · ') + HU.fmtClock(Date.now());
    }
  }

  function bindUI() {
    $('#btnAdd').addEventListener('click', () => openAddModal());
    $('#btnScan').addEventListener('click', () => openProposals({ global: true }));
    $('#btnGlobal').addEventListener('click', toggleGlobalView);
    $('#btnKB').addEventListener('click', openKBModal);
    $('#btnPhone').addEventListener('click', openPhoneModal);
    $('#btnHelp').addEventListener('click', openHelp);
    $('#btnMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#menu').classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrap')) $('#menu').classList.add('hidden');
    });
    $('#menu').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      $('#menu').classList.add('hidden');
      const act = btn.dataset.act;
      if (act === 'export') exportState();
      if (act === 'import') $('#fileInput').click();
      if (act === 'relayout') relayout();
      if (act === 'reset') confirmReset();
    });
    $('#fileInput').addEventListener('change', importState);

    $('#search').addEventListener('input', (e) => applySearch(e.target.value));
    $('#search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && searchIds && searchIds.size) {
        const first = state.nodes.find((n) => searchIds.has(n.id));
        if (first) select(first.id, { focus: true });
      }
      if (e.key === 'Escape') {
        e.target.value = '';
        applySearch('');
      }
    });

    $('#zoomIn').addEventListener('click', () => graph.zoomBy(1.22));
    $('#zoomOut').addEventListener('click', () => graph.zoomBy(1 / 1.22));
    $('#zoomFit').addEventListener('click', () => graph.fit());

    $('#timeRange').addEventListener('input', (e) => setTimeOffset(+e.target.value));
    $('#timeReset').addEventListener('click', () => setTimeOffset(0));
    document.querySelectorAll('.tb-presets button').forEach((b) => {
      b.addEventListener('click', () => setTimeOffset(+b.dataset.d));
    });

    $('#hintClose').addEventListener('click', () => $('#hint').classList.add('hide'));
    $('#lobeClear').addEventListener('click', () => setFilter(null));
    $('#lobeList').addEventListener('click', (e) => {
      const row = e.target.closest('.lobe');
      if (!row) return;
      setFilter(filterDomain === row.dataset.id ? null : row.dataset.id);
    });
    $('#dueList').addEventListener('click', (e) => {
      const act = e.target.closest('.due-act');
      if (act) {
        e.stopPropagation();
        doRecall(act.dataset.id);
        return;
      }
      const item = e.target.closest('.due-item');
      if (item) select(item.dataset.id, { focus: true });
    });
    $('#bridgeList').addEventListener('click', (e) => {
      if (e.target.closest('.bi-missing')) {
        openProposals({ global: true });
        return;
      }
      const item = e.target.closest('.bridge-item');
      if (!item) return;
      select(item.dataset.a, { focus: true });
      graph.setSearch([item.dataset.a, item.dataset.b]);
      setTimeout(() => { if (!searchIds) graph.setSearch(null); }, 1800);
    });

    $('#detail').addEventListener('click', onDetailClick);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('beforeunload', () => persistNow());
    window.addEventListener('resize', HU.debounce(() => { renderDue(); renderBridges(); }, 300));
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (activeModal) { closeModal(); return; }
      if ($('#search') === document.activeElement) return;
      if (selectedId) { select(null); return; }
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === '/') {
      e.preventDefault();
      $('#search').focus();
    } else if (e.key === 'f' || e.key === 'F') {
      graph.fit();
    } else if (e.key === 'n' || e.key === 'N') {
      openAddModal();
    } else if (e.key === 'g' || e.key === 'G') {
      toggleGlobalView();
    } else if (e.key === 'l' || e.key === 'L') {
      relayout();
    }
  }

  function applySearch(q) {
    q = String(q || '').trim().toLowerCase();
    const count = $('#searchCount');
    if (!q) {
      searchIds = null;
      graph.setSearch(null);
      count.textContent = '';
      renderAll();
      return;
    }
    const ids = state.nodes
      .filter((n) => ((n.title || '') + ' ' + (n.summary || '') + ' ' + (n.tags || []).join(' ')).toLowerCase().includes(q))
      .map((n) => n.id);
    searchIds = new Set(ids);
    graph.setSearch(ids);
    count.textContent = ids.length ? ids.length + ' 条' : '无结果';
    renderVitals();
    renderLobes();
  }

  function setFilter(id) {
    filterDomain = id;
    graph.setFilter(id);
    document.querySelectorAll('.lobe').forEach((row) => {
      row.classList.toggle('on', row.dataset.id === id);
      row.classList.toggle('dimmed', !!id && row.dataset.id !== id);
    });
    $('#lobeClear').classList.toggle('on', !!id);
    renderVitals();
  }

  function toggleGlobalView() {
    globalView = !globalView;
    graph.setGlobalView(globalView);
    $('#btnGlobal').classList.toggle('active', globalView);
    toast(globalView
      ? '全局视角 · 同域连线被隐去，只留下跨域突触：' + Model.stats(state, graph.now()).bridges + ' 座桥把学科连成一张网'
      : '已回到局部视角', globalView ? 'bridge' : '');
  }

  function relayout(showToast) {
    graph.setData(state.nodes, state.synapses, state.domains, { settle: true });
    graph.fit(72);
    save();
    if (showToast !== false) toast('已重新布局', 'good');
  }

  function select(id, opts) {
    const wasOpen = $('#detail').classList.contains('open');
    selectedId = id;
    graph.setSelected(id);
    graph.setInset(id ? 404 : 0);
    renderDetail();
    if (id && !wasOpen) graph.fit(72);
    else if (id && opts && opts.focus) graph.ensureVisible(id);
    else if (!id && wasOpen) graph.fit(72);
  }

  function renderDetail() {
    const panel = $('#detail');
    const node = selectedId ? Model.findNode(state, selectedId) : null;
    if (!node) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      return;
    }
    const now = graph.now();
    const dom = Model.domain(state, node.domain) || { name: '未分类', color: '#7aa2ff' };
    const r = Model.retention(node, now);
    const label = Model.LABEL(r);
    const pv = Model.previewRecall(node, now);
    const stability = node.stability || Model.initialStability(node);

    const links = [];
    for (const s of state.synapses) {
      if (s.source !== node.id && s.target !== node.id) continue;
      const w = Model.synapseWeight(s, now);
      if (w < 0.05) continue;
      const otherId = s.source === node.id ? s.target : s.source;
      const other = Model.findNode(state, otherId);
      if (!other) continue;
      links.push({ syn: s, other, w });
    }
    links.sort((a, b) => b.w - a.w);

    const linkHtml = links.length
      ? links.map((l) => {
        const d = Model.domain(state, l.other.domain) || { color: '#7aa2ff' };
        const cross = l.other.domain !== node.domain;
        const kind = l.syn.nascent ? '新生' : cross ? '跨域' : l.syn.kind === 'coact' ? '共激活' : '同域';
        return '<div class="link-row" data-id="' + l.other.id + '" style="color:' + d.color + '">' +
          '<span class="lr-dot"></span>' +
          '<span class="lr-title">' + esc(l.other.title) + '</span>' +
          '<span class="lr-meta"><span class="lr-kind ' + (cross ? 'cross' : '') + '">' + kind + '</span>' +
          Math.round(l.w * 100) + '%</span></div>';
      }).join('')
      : '<div class="link-empty">还没有突触。给它加一个概念标签，再点「建立联系」，看看它和谁有关。</div>';

    const lastText = node.recallCount ? HU.fmtAgo(node.lastRecalledAt, now) : '从未调用';
    const curveDays = 90;

    panel.innerHTML =
      '<div class="detail-scroll">' +
        '<div class="d-head">' +
          '<span class="d-chip" style="color:' + dom.color + '"><i></i>' + esc(dom.name) + '</span>' +
          '<button class="d-close" data-act="close" title="关闭">×</button>' +
        '</div>' +
        '<h3 class="d-title">' + esc(node.title) + '</h3>' +
        '<p class="d-summary">' + (node.summary ? esc(node.summary) : '（还没有写内容摘要）') + '</p>' +
        (node.tags && node.tags.length ? '<div class="d-tags">' + node.tags.map((t) => '<span class="d-tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
        (node.source && node.source.kind === 'file'
          ? '<div class="d-source"><span>来源</span>knowledge/' + esc(node.source.path || '') +
            (node.source.chunk && node.source.of ? ' · 第 ' + node.source.chunk + '/' + node.source.of + ' 块' : '') + '</div>'
          : '') +
        (node.source && node.source.kind === 'conversation'
          ? '<div class="d-source"><span>来源</span>对话 · 自动捕获' +
            (node.source.turn ? '（第 ' + node.source.turn + ' 轮）' : '') + '</div>'
          : '') +
        (node.source && /^phone-/.test(node.source.kind)
          ? '<div class="d-source"><span>来源</span>' +
            (node.source.kind === 'phone-photo' ? '手机 · 照片'
              : node.source.kind === 'phone-audio' ? '手机 · 录音' : '手机 · 文字') +
            (node.source.at ? ' · ' + fmtDate(node.source.at) : '') + '</div>' +
            (node.source.name && node.source.kind === 'phone-photo'
              ? '<div class="d-media"><img src="' + (REMOTE_BASE || '') + '/api/sense/file/' +
                encodeURIComponent(node.source.name) + '" alt="手机照片"></div>'
              : '') +
            (node.source.name && node.source.kind === 'phone-audio'
              ? '<div class="d-media"><audio controls preload="metadata" src="' + (REMOTE_BASE || '') +
                '/api/sense/file/' + encodeURIComponent(node.source.name) + '"></audio></div>'
              : '')
          : '') +

        '<div class="d-sec">' +
          '<div class="d-sec-head"><h4>可提取度</h4><em>RETRIEVAL</em></div>' +
          '<div class="strength"><b>' + Math.round(r * 100) + '<small>%</small></b>' +
            '<span class="s-label">' + label + '</span>' +
            '<span class="s-trend">稳定度 ' + HU.fmtSpan(stability) + '</span></div>' +
          '<div class="s-meter"><i style="width:' + Math.max(2, r * 100) + '%"></i></div>' +
          '<p class="s-hint">按当前稳定度，约 ' + HU.fmtSpan(Model.timeToThreshold(node, now, 0.35)) + '后降到 35% 的复习线。' +
            (pv.massed ? ' 刚刚已经调用过，密集重复的增益很小。' : '') + '</p>' +
        '</div>' +

        '<div class="d-sec">' +
          '<div class="d-sec-head"><h4>记忆时间线</h4><em>TIMELINE</em></div>' +
          '<div class="d-meta">' +
            '<div><span>编码于</span><b>' + fmtDate(node.createdAt) + '</b></div>' +
            '<div><span>最近调用</span><b>' + lastText + '</b></div>' +
            '<div><span>调用次数</span><b>' + (node.recallCount || 0) + ' 次</b></div>' +
            '<div><span>领域</span><b>' + esc(dom.name) + '</b></div>' +
          '</div>' +
        '</div>' +

        '<div class="d-sec">' +
          '<div class="d-sec-head"><h4>遗忘曲线</h4><em>NEXT ' + curveDays + ' DAYS</em></div>' +
          '<canvas id="curve"></canvas>' +
          '<div class="curve-legend"><span>今天</span><span>+30 天</span><span>+60 天</span><span>+90 天</span></div>' +
        '</div>' +

        '<div class="d-sec">' +
          '<div class="d-sec-head"><h4>关联突触</h4><em>' + links.length + ' 条</em></div>' +
          '<div class="link-list">' + linkHtml + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="d-actions">' +
        '<button class="btn primary" data-act="recall">回想一次 · 强化记忆</button>' +
        '<div class="row">' +
          '<button class="btn ghost" data-act="link">建立联系</button>' +
          '<button class="btn ghost" data-act="edit">编辑</button>' +
          '<button class="btn ghost" data-act="delete">删除</button>' +
        '</div>' +
        '<div class="recall-note">回想后稳定度 ' + HU.fmtSpan(stability) + ' → ' + HU.fmtSpan(pv.stability) + '</div>' +
      '</div>';

    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => drawCurve(node, curveDays));
  }

  function drawCurve(node, days) {
    const cv = $('#curve');
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 320;
    const h = 76;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pl = 6, pr = 6, pt = 10, pb = 12;
    const x0 = pl, x1 = w - pr, y0 = pt, y1 = h - pb;
    const X = (d) => x0 + (d / days) * (x1 - x0);
    const Y = (r) => y1 - r * (y1 - y0);

    ctx.strokeStyle = 'rgba(255,255,255,.055)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach((f) => {
      ctx.beginPath();
      ctx.moveTo(x0, Y(f));
      ctx.lineTo(x1, Y(f));
      ctx.stroke();
    });

    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255,140,170,.42)';
    ctx.beginPath();
    ctx.moveTo(x0, Y(0.35));
    ctx.lineTo(x1, Y(0.35));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,150,175,.65)';
    ctx.font = '8px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('35%', x1, Y(0.35) - 4);

    const pts = [];
    for (let d = 0; d <= days; d += 1.5) {
      pts.push([X(d), Y(Math.exp(-d / Math.max(0.6, node.stability || Model.initialStability(node))))]);
    }

    const grad = ctx.createLinearGradient(0, y0, 0, y1);
    grad.addColorStop(0, 'rgba(122,162,255,.28)');
    grad.addColorStop(1, 'rgba(122,162,255,0)');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], y1);
    pts.forEach((p) => ctx.lineTo(p[0], p[1]));
    ctx.lineTo(pts[pts.length - 1][0], y1);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
    ctx.strokeStyle = 'rgba(180,210,255,.9)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    const nowR = Model.retention(node, Date.now() + graph.timeOffsetDays * HU.DAY);
    ctx.beginPath();
    ctx.arc(X(0) + 1.5, Y(nowR), 2.6, 0, Math.PI * 2);
    ctx.fillStyle = '#eaf6ff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(X(0) + 1.5, Y(nowR), 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180,215,255,.16)';
    ctx.fill();
  }

  function onDetailClick(e) {
    const actEl = e.target.closest('[data-act]');
    if (actEl) {
      const act = actEl.dataset.act;
      if (act === 'close') select(null);
      if (act === 'recall') doRecall(selectedId);
      if (act === 'link') openProposals({ nodeId: selectedId });
      if (act === 'edit') openAddModal({ editId: selectedId });
      if (act === 'delete') confirmDelete(selectedId);
      return;
    }
    const row = e.target.closest('.link-row');
    if (row) select(row.dataset.id, { focus: true });
  }

  function doRecall(id) {
    const node = Model.findNode(state, id);
    if (!node) return;
    if (timeOffset > 0) {
      setTimeOffset(0);
      toast('已回到「今天」，回想的时间点按现实记录', 'warn');
    }
    const now = Date.now();
    const res = Model.recall(state, id, now);
    if (!res) return;

    Model.spread(state, id, now, 0.032);
    graph.pulseFrom(id);
    graph.floater(id, '稳定度 ' + HU.fmtSpan(res.stabilityBefore) + ' → ' + HU.fmtSpan(res.stabilityAfter));

    const prev = sessionRecalls.filter((x) => x.id !== id && now - x.t < 45 * 60000).pop();
    if (prev) {
      const a = Model.findNode(state, prev.id);
      const co = Model.coactivate(state, prev.id, id, now);
      if (co && a) {
        graph.synapseBorn(co.synapse);
        if (co.type === 'nascent') {
          toast('共激活 · 「' + a.title + '」与「' + node.title + '」之间长出一条微弱突触', 'bridge');
        } else if (co.type === 'consolidated') {
          toast('突触巩固 · 「' + a.title + '」⇄「' + node.title + '」，再共激活一次会更强', 'good');
        }
      }
    }
    sessionRecalls.push({ id, t: now });
    if (sessionRecalls.length > 40) sessionRecalls = sessionRecalls.slice(-40);

    save();
    renderVitals();
    renderDue();
    renderBridges();
    renderDetail();
    emit('recall', { id, before: res.before, after: res.after, stability: res.stabilityAfter });

    if (res.massed) {
      toast('集中重复的收益很小 · 隔一天再回想，稳定度会涨得更多', 'warn');
    }
  }

  function connect(a, b) {
    if (!a || !b || a.id === b.id) return;
    const existing = state.synapses.find(
      (s) => (s.source === a.id && s.target === b.id) || (s.source === b.id && s.target === a.id)
    );
    if (existing) {
      toast('这两个记忆之间已经有突触了');
      return;
    }
    const cross = a.domain !== b.domain;
    const syn = Model.createSynapse(state, a.id, b.id, {
      kind: cross ? 'bridge' : 'assoc',
      weight: 0.5,
      reason: '手动建立：在一次思考中被放在一起',
      now: graph.now()
    });
    if (!syn) return;
    graph.synapseBorn(syn);
    graph.pulseFrom(a.id);
    save();
    renderAll();
    toast('已建立' + (cross ? '跨域' : '同域') + '突触 · ' + a.title + ' ⇄ ' + b.title, 'bridge');
    emit('synapse', { source: a.id, target: b.id, kind: syn.kind });
  }

  function renderAll() {
    renderVitals();
    renderLobes();
    renderDue();
    renderBridges();
    renderDetail();
    $('#clock').textContent = HU.fmtClock(Date.now());
  }

  function renderVitals() {
    const now = graph.now();
    const st = Model.stats(state, now);
    const cov = domainCoverage(now);
    $('#statNodes').textContent = st.nodes;
    $('#statSyn').textContent = st.synapses;
    $('#statBridge').textContent = st.bridges;
    $('#statVitality').textContent = Math.round(st.retention * 100) + '%';
    $('#vitalBar').style.width = Math.max(3, st.retention * 100) + '%';
    $('#vitalNote').innerHTML = st.clear + ' 条清晰 · ' + st.faded + ' 条正在变淡<br>' +
      '<b>' + cov.connected + '/' + cov.total + '</b> 对脑区已连通' +
      (cov.missing.length ? ' · 还缺 ' + esc(cov.missing[0]) : ' · 连成一张网');
  }

  function domainCoverage(now) {
    const pairs = new Map();
    for (const s of state.synapses) {
      const a = Model.findNode(state, s.source);
      const b = Model.findNode(state, s.target);
      if (!a || !b || a.domain === b.domain) continue;
      if (Model.synapseWeight(s, now) < 0.08) continue;
      const key = [a.domain, b.domain].sort().join('|');
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
    const total = state.domains.length * (state.domains.length - 1) / 2;
    const missing = [];
    for (let i = 0; i < state.domains.length; i++) {
      for (let j = i + 1; j < state.domains.length; j++) {
        const key = [state.domains[i].id, state.domains[j].id].sort().join('|');
        if (!pairs.has(key)) missing.push(state.domains[i].name + ' ↔ ' + state.domains[j].name);
      }
    }
    return { connected: pairs.size, total, missing };
  }

  function renderLobes() {
    const st = Model.stats(state, graph.now());
    $('#lobeList').innerHTML = state.domains.map((d) => {
      const info = st.byDomain[d.id] || { count: 0, retention: 0 };
      return '<div class="lobe' + (filterDomain === d.id ? ' on' : '') + (filterDomain && filterDomain !== d.id ? ' dimmed' : '') +
        '" data-id="' + d.id + '" style="color:' + d.color + '">' +
        '<span class="swatch"></span>' +
        '<span class="l-name">' + esc(d.name) + '</span>' +
        '<span class="l-count">' + info.count + '</span>' +
        '<span class="l-bar"><i style="width:' + Math.round(info.retention * 100) + '%"></i></span>' +
        '</div>';
    }).join('');
  }

  function renderDue() {
    const now = graph.now();
    const items = Model.due(state, now, window.innerHeight < 960 ? 2 : 3);
    if (!items.length) {
      $('#dueList').innerHTML = '<div class="bi-empty">记忆状态良好，暂时没有需要强化的节点。</div>';
      return;
    }
    $('#dueList').innerHTML = items.map((it) => {
      const d = Model.domain(state, it.node.domain) || { name: '' };
      return '<div class="due-item" data-id="' + it.node.id + '">' +
        '<div class="due-top"><span class="due-title">' + esc(it.node.title) + '</span>' +
        '<button class="due-act" data-id="' + it.node.id + '">回想</button></div>' +
        '<div class="due-meta"><span>' + esc(d.name) + '</span><b>' + Math.round(it.retention * 100) + '%</b></div>' +
        '<div class="due-bar"><i style="width:' + Math.max(2, it.retention * 100) + '%"></i></div>' +
        '</div>';
    }).join('');
  }

  function renderBridges() {
    const now = graph.now();
    const cov = domainCoverage(now);
    const items = Model.insights(state, now, window.innerHeight < 960 ? 2 : 3);
    const missingLine = cov.missing.length
      ? '<div class="bi-missing">还缺：' + esc(cov.missing[0]) + ' →</div>'
      : '<div class="bi-missing ok">所有脑区已经连成一张网</div>';

    if (!items.length) {
      $('#bridgeList').innerHTML = '<div class="bi-empty">还没有跨域突触。做一次「关联扫描」，让不同学科之间连起来。</div>' + missingLine;
      return;
    }
    $('#bridgeList').innerHTML = items.map((it) => {
      const da = Model.domain(state, it.a.domain) || { color: '#4cc9f0' };
      const db = Model.domain(state, it.b.domain) || { color: '#ff6b9a' };
      return '<div class="bridge-item" data-a="' + it.a.id + '" data-b="' + it.b.id + '">' +
        '<div class="bi-pair"><i style="color:' + da.color + '"></i><span>' + esc(it.a.title) + '</span>' +
        '<em>⇄</em><i style="color:' + db.color + '"></i><span>' + esc(it.b.title) + '</span></div>' +
        '<div class="bi-reason">' + esc(it.synapse.reason || '跨域联系') + '</div>' +
        '</div>';
    }).join('') + missingLine;
  }

  function setTimeOffset(days) {
    timeOffset = days;
    $('#timeRange').value = days;
    paintTimeSlider(days);
    graph.setTimeOffset(days);
    $('#timeValue').textContent = days === 0 ? '今天' : '+' + days + ' 天';
    $('#timeReset').classList.toggle('hidden', days === 0);
    clearTimeout(timeRenderTimer);
    timeRenderTimer = setTimeout(() => {
      renderVitals();
      renderLobes();
      renderDue();
      renderBridges();
      renderDetail();
    }, 60);
  }

  function paintTimeSlider(days) {
    const el = $('#timeRange');
    if (!el) return;
    const pct = HU.clamp(days / 180, 0, 1) * 100;
    el.style.background = 'linear-gradient(90deg, rgba(122,162,255,.85) 0%, rgba(122,162,255,.85) ' + pct +
      '%, rgba(255,255,255,.1) ' + pct + '%, rgba(255,255,255,.1) 100%)';
  }

  function toast(msg, kind) {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    const dot = document.createElement('i');
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(dot);
    t.appendChild(span);
    box.appendChild(t);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 260);
    }, 4000);
  }

  function onHover(node) {
    const tip = $('#tooltip');
    if (!node) {
      tip.classList.remove('on');
      return;
    }
    const d = Model.domain(state, node.domain) || { name: '', color: '#7aa2ff' };
    const r = Model.retention(node, graph.now());
    tip.innerHTML = '<div class="tt-title">' + esc(node.title) + '</div>' +
      '<div class="tt-sub" style="color:' + d.color + '"><i></i>' + esc(d.name) + ' · ' + Math.round(r * 100) + '% 可提取</div>' +
      '<div class="tt-bar"><b style="width:' + Math.round(r * 100) + '%"></b></div>';

    const s = graph.worldToScreen(node.x, node.y);
    const rect = $('#brain').getBoundingClientRect();
    const x = HU.clamp(rect.left + s.x, 150, window.innerWidth - 150);
    const y = rect.top + s.y - 12;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
    tip.classList.add('on');
  }

  function openModal(html, opts) {
    closeModal();
    opts = opts || {};
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = '<div class="modal ' + (opts.wide ? 'wide' : '') + '">' + html + '</div>';
    $('#modalRoot').appendChild(backdrop);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) closeModal();
    });
    activeModal = backdrop;
    return backdrop.querySelector('.modal');
  }

  function closeModal() {
    if (activeModal) {
      activeModal.remove();
      activeModal = null;
    }
    if (!activeModal && pendingRemote) setTimeout(flushPendingRemote, 60);
  }

  function openAddModal(opts) {
    opts = opts || {};
    const editing = opts.editId ? Model.findNode(state, opts.editId) : null;
    const domainOptions = state.domains.map((d) =>
      '<option value="' + d.id + '"' + (editing && editing.domain === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>'
    ).join('') + '<option value="__new">+ 新建领域…</option>';

    const tagCount = new Map();
    for (const n of state.nodes) {
      if (editing && n.id === editing.id) continue;
      for (const t of n.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
    const suggestions = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    const modal = openModal(
      '<div class="m-head"><div><h3>' + (editing ? '编辑记忆' : '添加一条记忆') + '</h3>' +
        '<p>' + (editing ? '修改后会保留原有的记忆强度与突触。' : '标题与概念标签越具体，越容易被正确联想。') + '</p></div>' +
        '<button class="m-close" data-close>×</button></div>' +
      '<div class="field"><label>记忆标题 <em>必填</em></label>' +
        '<input id="fTitle" type="text" maxlength="60" placeholder="例如：用傅里叶变换给心电信号降噪" value="' + (editing ? esc(editing.title) : '') + '"></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>所属领域</label><select id="fDomain">' + domainOptions + '</select></div>' +
        '<div class="field"><label>重要度</label><div class="range-row">' +
          '<input id="fImp" type="range" min="0.1" max="1" step="0.05" value="' + (editing ? editing.importance : 0.6) + '">' +
          '<b id="fImpVal">' + Math.round((editing ? editing.importance : 0.6) * 100) + '</b></div></div>' +
      '</div>' +
      '<div class="field hidden" id="newDomainField"><label>新领域名称</label><input id="fNewDomain" type="text" maxlength="12" placeholder="例如：数据结构"></div>' +
      '<div class="field"><label>概念标签 <em>逗号分隔，联想的钩子</em></label>' +
        '<input id="fTags" type="text" placeholder="傅里叶, 降噪, 信号" value="' + (editing ? esc((editing.tags || []).join(', ')) : '') + '">' +
        (suggestions.length ? '<div class="chips" id="tagSuggest">' + suggestions.map(([t]) =>
          '<button class="chip" data-tag="' + esc(t) + '">' + esc(t) + '</button>').join('') + '</div>' : '') +
      '</div>' +
      '<div class="field"><label>内容摘要 <em>它是什么？和什么有关？</em></label>' +
        '<textarea id="fSummary" maxlength="300" placeholder="用一句话写清楚：它解决什么问题，和哪些概念有联系…">' + (editing ? esc(editing.summary) : '') + '</textarea></div>' +
      '<div class="m-foot"><span class="note">保存后会扫描潜在联系</span><span class="spacer"></span>' +
        '<button class="btn ghost" data-close>取消</button>' +
        '<button class="btn primary" id="mSave">' + (editing ? '保存修改' : '编码入库') + '</button></div>',
      {}
    );

    const titleInput = modal.querySelector('#fTitle');
    const domainSel = modal.querySelector('#fDomain');
    const newField = modal.querySelector('#newDomainField');
    const imp = modal.querySelector('#fImp');
    const impVal = modal.querySelector('#fImpVal');
    const tagsInput = modal.querySelector('#fTags');

    setTimeout(() => titleInput.focus(), 60);

    domainSel.addEventListener('change', () => {
      newField.classList.toggle('hidden', domainSel.value !== '__new');
      if (domainSel.value === '__new') modal.querySelector('#fNewDomain').focus();
    });
    imp.addEventListener('input', () => { impVal.textContent = Math.round(imp.value * 100); });
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeModal();
      const chip = e.target.closest('.chip[data-tag]');
      if (chip) {
        const tag = chip.dataset.tag;
        const cur = tagsInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (!cur.includes(tag)) cur.push(tag);
        tagsInput.value = cur.join(', ');
        tagsInput.focus();
      }
    });
    modal.querySelector('#mSave').addEventListener('click', () => {
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        toast('先给这条记忆起个名字', 'warn');
        return;
      }
      let domain = domainSel.value;
      if (domain === '__new') {
        const name = modal.querySelector('#fNewDomain').value.trim();
        if (!name) {
          modal.querySelector('#fNewDomain').focus();
          toast('请输入新领域的名称', 'warn');
          return;
        }
        const exists = state.domains.find((d) => d.name === name);
        if (exists) domain = exists.id;
        else {
          domain = HU.uid('d_');
          state.domains.push({ id: domain, name, color: PALETTE[state.domains.length % PALETTE.length] });
        }
      }
      const tags = tagsInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
      const summary = modal.querySelector('#fSummary').value.trim();
      const importance = +imp.value;

      if (editing) {
        Model.updateNode(state, editing.id, { title, summary, domain, tags, importance });
        graph.setData(state.nodes, state.synapses, state.domains, { settle: false });
        closeModal();
        save(true);
        renderAll();
        graph.focusNode(editing.id);
        toast('已更新「' + title + '」', 'good');
        emit('update', { id: editing.id });
        return;
      }

      const node = Model.addMemory(state, { title, summary, domain, tags, importance }, Date.now());
      graph.setData(state.nodes, state.synapses, state.domains, { settle: false });
      closeModal();
      save(true);
      renderAll();
      select(node.id);
      toast('已编码入库 · 正在寻找与它有关的记忆…', 'good');
      emit('add', { id: node.id });

      setTimeout(() => {
        const props = Model.proposals(state, { nodeId: node.id, threshold: state.settings.threshold, now: Date.now(), limit: 8 });
        if (props.length) openProposals({ nodeId: node.id, auto: true });
        else toast('暂时没有发现强关联 · 可以手动连一条突触', 'warn');
      }, 700);
    });
  }

  function openProposals(cfg) {
    cfg = cfg || {};
    let threshold = HU.clamp(state.settings.threshold || 0.32, 0.2, 0.65);
    const scopedId = cfg.nodeId || null;

    const build = () => {
      const props = Model.proposals(state, {
        nodeId: scopedId || undefined,
        threshold,
        now: graph.now(),
        limit: 12
      });
      const scopedNode = scopedId ? Model.findNode(state, scopedId) : null;

      const rows = props.length ? props.map((p, i) => {
        const da = Model.domain(state, p.a.domain) || { color: '#4cc9f0' };
        const db = Model.domain(state, p.b.domain) || { color: '#ff6b9a' };
        return '<div class="proposal" data-i="' + i + '">' +
          '<span class="p-dot" style="color:' + (p.cross ? db.color : da.color) + '"></span>' +
          '<div><div class="p-title">' + esc(p.a.title) + '<span>⇄</span>' + esc(p.b.title) + '</div>' +
          '<div class="p-meta"><span class="p-badge ' + (p.cross ? '' : 'same') + '">' + (p.cross ? '跨域' : '同域') + '</span>' +
          '<span>' + esc(reasonText(p)) + '</span></div></div>' +
          '<div style="text-align:right"><div class="p-score">' + Math.round(p.score * 100) + '<small>%</small></div>' +
          '<button data-connect="' + i + '">建立</button></div>' +
          '</div>';
      }).join('') : '<div class="link-empty" style="padding:10px 2px">没有超过阈值的潜在联系。降低阈值，或给记忆补充更具体的概念标签。</div>';

      const modal = openModal(
        '<div class="m-head"><div><h3>' + (scopedNode ? '与「' + esc(scopedNode.title) + '」有关的潜在联系' : '关联扫描') + '</h3>' +
          '<p>' + (scopedNode ? '基于共享概念、文本相似与共同邻居计算；采纳后会生成一条新突触。' : '找出概念相近、但还没有连线的记忆；跨域联系有助于建立全局理解。') + '</p></div>' +
          '<button class="m-close" data-close>×</button></div>' +
        '<div class="threshold-row"><span>联系阈值</span><input id="pThreshold" type="range" min="0.2" max="0.65" step="0.01" value="' + threshold + '">' +
          '<b id="pThresholdVal">' + Math.round(threshold * 100) + '%</b>' +
          '<span style="margin-left:auto;color:#4d5a70">' + props.length + ' 条候选</span></div>' +
        '<div class="proposal-list" id="proposalList">' + rows + '</div>' +
        '<div class="m-foot"><span class="note">联想是双向的：连上之后，两个脑区会一起亮起来</span><span class="spacer"></span>' +
          '<button class="btn ghost" data-close>稍后再说</button></div>',
        { wide: true }
      );

      const slider = modal.querySelector('#pThreshold');
      const val = modal.querySelector('#pThresholdVal');
      let timer = null;
      slider.addEventListener('input', () => {
        threshold = +slider.value;
        val.textContent = Math.round(threshold * 100) + '%';
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.settings.threshold = threshold;
          save();
          const scrollTop = modal.scrollTop;
          build();
          const m2 = activeModal ? activeModal.querySelector('.modal') : null;
          if (m2) m2.scrollTop = scrollTop;
        }, 220);
      });

      modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) { closeModal(); return; }
        const btn = e.target.closest('[data-connect]');
        if (!btn) return;
        const p = props[+btn.dataset.connect];
        if (!p) return;
        const syn = Model.createSynapse(state, p.a.id, p.b.id, {
          kind: p.cross ? 'bridge' : 'assoc',
          weight: Math.min(0.95, 0.4 + 0.45 * p.score),
          reason: reasonText(p) + ' · 系统联想',
          now: graph.now()
        });
        if (!syn) {
          btn.disabled = true;
          btn.textContent = '已存在';
          return;
        }
        graph.synapseBorn(syn);
        graph.pulseFrom(p.a.id);
        save();
        renderAll();
        btn.disabled = true;
        btn.textContent = '已建立';
        toast('突触形成 · ' + p.a.title + ' ⇄ ' + p.b.title, 'bridge');
        emit('synapse', { source: p.a.id, target: p.b.id, kind: syn.kind });
      });
    };

    build();
  }

  function reasonText(p) {
    if (p.basis === 'concept' && p.shared && p.shared.length) {
      return '共享概念：' + p.shared.slice(0, 3).join('、');
    }
    if (p.basis === 'via' && p.via && p.via.length) {
      const via = Model.findNode(state, p.via[0]);
      return '经由「' + (via ? via.title : '中转记忆') + '」的间接联想';
    }
    if (p.shared && p.shared.length) return '共享概念：' + p.shared.slice(0, 3).join('、');
    return '文本语义相近';
  }

  function openHelp() {
    const modal = openModal(
      '<div class="m-head"><div><h3>怎么读这张脑图</h3>' +
        '<p>它不是在「存笔记」，而是在模拟记忆的可提取程度。</p></div>' +
        '<button class="m-close" data-close>×</button></div>' +
      '<div class="help-grid">' +
        '<div class="help-card"><h5>亮度 = 可提取度</h5><p>越久没调用、调用次数越少，节点越暗。暗到只剩一圈虚线时，它还没有消失，只是<b>很难被提取</b>。</p></div>' +
        '<div class="help-card"><h5>大小 = 编码深度</h5><p>重要度越高，节点越大。重要的记忆即使变暗，也会保留更明显的痕迹。</p></div>' +
        '<div class="help-card"><h5>连线 = 突触</h5><p>同域是细线，跨域是彩色渐变。被一起调用的记忆会长出新突触，长期不用会休眠。</p></div>' +
        '<div class="help-card"><h5>颜色 = 脑区</h5><p>每个学科/项目是一块脑区。跨域桥越多，说明知识之间的迁移越活跃。</p></div>' +
        '<div class="help-card" style="grid-column:1/-1"><h5>全局视角 = 只看桥</h5><p>按下 <b>G</b> 会隐去同域连线，只留下跨域突触：你能一眼看到「数学、物理、AI、项目」是否已经连成一张网，而不只是六个孤岛。</p></div>' +
      '</div>' +
      '<div class="formula">R(t) = e<sup>−Δt / S</sup>　　R：可提取度　S：稳定度<br>' +
        '每次回想后 S 变大；间隔越久再回想，增长越多（间隔效应）</div>' +
      '<div style="margin-top:16px"><div class="sec-head"><span class="kicker">KEYS</span><h2>快捷操作</h2></div>' +
        '<div class="kbd-list">' +
          '<span><kbd>/</kbd> 搜索记忆</span>' +
          '<span><kbd>N</kbd> 添加记忆</span>' +
          '<span><kbd>F</kbd> 适应视图</span>' +
          '<span><kbd>L</kbd> 重新布局</span>' +
          '<span><kbd>G</kbd> 全局视角 / 局部视角</span>' +
          '<span><kbd>双击</kbd> 回想一次</span>' +
          '<span><kbd>Shift</kbd> + 拖拽 在两个节点间手动连突触</span>' +
          '<span><kbd>Esc</kbd> 关闭面板</span>' +
        '</div></div>' +
      '<div class="m-foot"><span class="note">所有数据只保存在这台电脑的浏览器里</span><span class="spacer"></span>' +
        '<button class="btn primary" data-close>开始探索</button></div>',
      { wide: true }
    );
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
  }

  /* ══════════════ 知识库 ══════════════ */
  async function openKBModal() {
    if (!remoteMode) {
      toast('知识库需要 DSH 记忆服务（8130）· 先启动 DSH，或运行 node dsh/mcp-hippocampus.js --http-only', 'warn');
      return;
    }
    const modal = openModal(
      '<div class="m-head"><div><h3>知识库</h3>' +
        '<p>把资料拖进来，或放进项目里的 <b>knowledge/</b> 文件夹；海马体会自动切块、入库、建立联想。</p></div>' +
        '<button class="m-close" data-close>×</button></div>' +
      '<div class="kb-status" id="kbStatus"><span class="kb-dot"></span>正在读取知识库…</div>' +
      '<div class="kb-drop" id="kbDrop">' +
        '<svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7 9m5-5 5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
        '<b>把文件拖到这里</b>' +
        '<span>或点击选择 · md / txt / json / docx / pdf / pptx / xlsx / 图片</span>' +
        '<input id="kbFile" type="file" multiple hidden>' +
      '</div>' +
      '<div class="field-row" style="margin-top:12px">' +
        '<div class="field" style="margin-bottom:0"><label>归入领域</label><select id="kbDomain"><option value="">自动识别</option>' +
          state.domains.map((d) => '<option value="' + d.id + '">' + esc(d.name) + '</option>').join('') +
        '</select></div>' +
        '<div class="field" style="margin-bottom:0"><label>文件夹</label><div class="kb-actions">' +
          '<button class="btn ghost" id="kbScan">扫描</button>' +
          '<button class="btn ghost" id="kbOpen">打开</button>' +
        '</div></div>' +
      '</div>' +
      '<div class="kb-files" id="kbFiles"></div>' +
      '<div class="m-foot"><span class="note">文件改动会自动重新入库；图片暂不做 OCR</span><span class="spacer"></span>' +
        '<button class="btn primary" data-close>完成</button></div>',
      { wide: true }
    );

    const statusEl = modal.querySelector('#kbStatus');
    const filesEl = modal.querySelector('#kbFiles');
    const drop = modal.querySelector('#kbDrop');
    const input = modal.querySelector('#kbFile');

    const renderStatus = (s) => {
      const last = s.lastScan && s.lastScan.at ? HU.fmtAgo(s.lastScan.at, Date.now()) : '尚未扫描';
      const err = s.errors && s.errors.length
        ? '<span class="kb-err">最近错误：' + esc(s.errors[s.errors.length - 1].error) + '</span>'
        : '';
      statusEl.innerHTML = '<span class="kb-dot"></span>已索引 <b>' + s.files + '</b> 个文件 · 生成 <b>' + s.nodes + '</b> 条记忆' +
        ' · 最近扫描 ' + esc(last) + err;
      const recent = (s.recent || []).slice().reverse();
      filesEl.innerHTML = recent.length
        ? recent.map((f) => '<div class="kb-file"><div class="kb-file-top"><span class="kb-file-title">' + esc(f.title) + '</span>' +
            '<span class="kb-file-n">' + f.nodes + ' 条</span></div><div class="kb-file-path">' + esc(f.path) + '</div></div>').join('')
        : '<div class="link-empty" style="padding:6px 2px">还没有文件。把 .md 放进 knowledge/，或拖进来。</div>';
    };

    const refresh = async () => {
      try {
        const s = await fetch(REMOTE_BASE + '/api/kb/status', { cache: 'no-store' }).then((r) => r.json());
        if (modal.isConnected) renderStatus(s);
      } catch (e) {
        if (modal.isConnected) statusEl.innerHTML = '<span class="kb-dot busy"></span>知识库服务不可用';
      }
    };

    const upload = async (fileList) => {
      const files = Array.from(fileList || []).filter(Boolean);
      if (!files.length) return;
      const domain = modal.querySelector('#kbDomain').value;
      let added = 0;
      const errors = [];
      for (const file of files) {
        statusEl.innerHTML = '<span class="kb-dot busy"></span>正在解析 ' + esc(file.name) + '…';
        try {
          const r = await fetch(REMOTE_BASE + '/api/kb/upload?name=' + encodeURIComponent(file.name) +
            '&domain=' + encodeURIComponent(domain), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || '上传失败');
          added += d.added || 0;
        } catch (e) {
          errors.push(file.name + '：' + e.message);
        }
      }
      await refresh();
      if (added) toast('知识库入库 ' + added + ' 条记忆', 'good');
      if (errors.length) toast('部分文件失败：' + errors[0], 'warn');
    };

    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { upload(input.files); input.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      upload(e.dataTransfer.files);
    });

    modal.querySelector('#kbScan').addEventListener('click', async () => {
      statusEl.innerHTML = '<span class="kb-dot busy"></span>正在扫描文件夹…';
      try {
        const r = await fetch(REMOTE_BASE + '/api/kb/scan', { method: 'POST' });
        const d = await r.json();
        await refresh();
        toast('扫描完成 · 新增 ' + ((d.scan && d.scan.added) || 0) + ' 条', 'good');
      } catch (e) {
        await refresh();
        toast('扫描失败：' + e.message, 'warn');
      }
    });
    modal.querySelector('#kbOpen').addEventListener('click', async () => {
      try {
        await fetch(REMOTE_BASE + '/api/kb/open', { method: 'POST' });
        toast('已打开知识库文件夹', 'good');
      } catch (e) {
        toast('打开失败：' + e.message, 'warn');
      }
    });
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

    await refresh();
  }

  /* ══════════════ 手机感官 ══════════════ */
  async function openPhoneModal() {
    if (!remoteMode) {
      toast('手机感官需要 DSH 记忆服务（8130）· 先启动 DSH', 'warn');
      return;
    }
    let info;
    try {
      info = await fetch(REMOTE_BASE + '/api/mobile-info', { cache: 'no-store' }).then((r) => r.json());
    } catch (e) {
      toast('手机服务暂不可用：' + e.message, 'warn');
      return;
    }
    if (!info || !info.ok) {
      toast('手机服务暂不可用', 'warn');
      return;
    }
    const url = info.url || '';
    const modal = openModal(
      '<div class="m-head"><div><h3>手机感官</h3>' +
        '<p>手机和电脑连同一个 Wi-Fi，扫码打开。拍照、录音、文字都会变成脑图里的节点。</p></div>' +
        '<button class="m-close" data-close>×</button></div>' +
      '<div class="phone-grid">' +
        '<div class="phone-qr"><img id="phoneQr" hidden alt="手机配对二维码"><div id="phoneQrHint" class="phone-qr-empty">二维码生成中…</div></div>' +
        '<div class="phone-side">' +
          '<label style="font-size:10px;color:#70809a;letter-spacing:.8px">配对地址</label>' +
          '<div class="phone-url"><code id="phoneUrl">' + esc(url || '没有检测到局域网 IPv4') + '</code>' +
            (url ? '<button class="btn ghost" id="phoneCopy">复制</button>' : '') + '</div>' +
          '<p class="phone-note">同一个 Wi-Fi；手机打开上面的地址，或直接扫码。配对码已经包含在地址里。</p>' +
          '<p class="phone-note">当前是 HTTP：拍照和文件上传可用；直接开麦需要 HTTPS，录音可以先用系统录音机录好再选文件。</p>' +
          '<a class="phone-open" id="phoneOpen" href="' + esc((REMOTE_BASE || '') + '/m?token=' + encodeURIComponent(info.token)) + '" target="_blank" rel="noopener">在本机打开手机页（测试开麦）</a>' +
        '</div>' +
      '</div>' +
      '<div class="phone-recent-head">最近送来的</div>' +
      '<div id="phoneRecent" class="phone-recent"><div class="link-empty" style="padding:8px 2px">还没有手机记忆。</div></div>' +
      '<div class="m-foot"><span class="note">局域网 HTTP · 只有本机与配对手机能上传</span><span class="spacer"></span>' +
        '<button class="btn primary" data-close>完成</button></div>',
      { wide: true }
    );
    modal.addEventListener('click', (event) => { if (event.target.closest('[data-close]')) closeModal(); });

    if (info.addresses && info.addresses.length > 1) {
      const alt = modal.querySelector('#phoneUrl');
      if (alt && url) alt.title = info.addresses.map((a) => a.name + ': ' + a.address).join('\n');
    }

    if (url) {
      fetch(REMOTE_BASE + '/api/mobile-qr', { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error('qr'); return r.blob(); })
        .then((blob) => {
          const img = modal.querySelector('#phoneQr');
          if (!img || !modal.isConnected) return;
          img.src = URL.createObjectURL(blob);
          img.hidden = false;
          const hint = modal.querySelector('#phoneQrHint');
          if (hint) hint.hidden = true;
        })
        .catch(() => {
          const hint = modal.querySelector('#phoneQrHint');
          if (hint) hint.textContent = '二维码生成失败，用地址打开';
        });
    }

    const copy = modal.querySelector('#phoneCopy');
    if (copy) {
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('配对地址已复制', 'good');
        } catch (e) {
          const code = modal.querySelector('#phoneUrl');
          if (code) {
            const range = document.createRange();
            range.selectNodeContents(code);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            toast('已选中地址，按 Ctrl+C 复制', 'warn');
          }
        }
      });
    }

    const loadRecent = async () => {
      try {
        const data = await fetch(REMOTE_BASE + '/api/sense/recent?limit=4', { cache: 'no-store' }).then((r) => r.json());
        const list = modal.querySelector('#phoneRecent');
        if (!list || !modal.isConnected) return;
        if (!data.results || !data.results.length) {
          list.innerHTML = '<div class="link-empty" style="padding:8px 2px">还没有手机记忆。</div>';
          return;
        }
        list.innerHTML = data.results.map((item) => {
          const media = item.kind === 'phone-photo' && item.url
            ? '<img src="' + esc(REMOTE_BASE + item.url) + '" alt="">'
            : '<span class="ph-icon">' + (item.kind === 'phone-audio' ? '♪' : '✎') + '</span>';
          const label = item.kind === 'phone-photo' ? '照片' : item.kind === 'phone-audio' ? '录音' : '文字';
          return '<div class="phone-item" data-id="' + esc(item.id) + '"><div class="ph-thumb">' + media + '</div>' +
            '<div class="ph-main"><b>' + esc(item.title) + '</b><span>' + label + ' · ' + HU.fmtAgo(item.createdAt, Date.now()) + '</span></div></div>';
        }).join('');
      } catch (e) { /* 静默 */ }
    };
    await loadRecent();

    modal.querySelector('#phoneRecent').addEventListener('click', (event) => {
      const row = event.target.closest('[data-id]');
      if (!row) return;
      closeModal();
      select(row.dataset.id);
    });
  }

  function confirmDelete(id) {
    const node = Model.findNode(state, id);
    if (!node) return;
    const modal = openModal(
      '<div class="m-head"><div><h3>删除这条记忆？</h3>' +
        '<p>「' + esc(node.title) + '」以及它的所有突触会一起移除，无法撤销。</p></div>' +
        '<button class="m-close" data-close>×</button></div>' +
      '<div class="m-foot"><span class="note">如果只是想让它变淡，把它放着不管就好</span><span class="spacer"></span>' +
        '<button class="btn ghost" data-close>取消</button>' +
        '<button class="btn primary" id="mDelete" style="background:linear-gradient(135deg,#ff5c7a,#ff8f6b)">删除</button></div>',
      {}
    );
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeModal();
    });
    modal.querySelector('#mDelete').addEventListener('click', () => {
      Model.removeNode(state, id);
      if (selectedId === id) select(null);
      closeModal();
      forceNextSave = true;
      save(true);
      renderAll();
      graph.setData(state.nodes, state.synapses, state.domains, { settle: false });
      toast('记忆已删除');
      emit('remove', { id });
    });
  }

  function confirmReset() {
    const modal = openModal(
      '<div class="m-head"><div><h3>重置为示例脑？</h3>' +
        '<p>当前所有节点、突触与调用记录会被清空，恢复到内置的示例知识网络。</p></div>' +
        '<button class="m-close" data-close>×</button></div>' +
      '<div class="m-foot"><span class="note">建议先「导出记忆库」备份</span><span class="spacer"></span>' +
        '<button class="btn ghost" data-close>取消</button>' +
        '<button class="btn primary" id="mReset" style="background:linear-gradient(135deg,#ff5c7a,#ff8f6b)">重置</button></div>',
      {}
    );
    modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
    modal.querySelector('#mReset').addEventListener('click', () => {
      localStorage.removeItem(KEY);
      state = Seed.create();
      forceNextSave = true;
      persistNow();
      selectedId = null;
      filterDomain = null;
      graph.setData(state.nodes, state.synapses, state.domains);
      graph.setSelected(null);
      graph.setFilter(null);
      graph.setInset(0);
      closeModal();
      graph.fit();
      renderAll();
      toast('已恢复示例脑', 'good');
    });
  }

  function exportState() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = 'hippocampus-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('记忆库已导出', 'good');
  }

  function importState(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.domains)) throw new Error('bad');
        if (!Array.isArray(data.synapses)) data.synapses = [];
        state = data;
        if (!state.settings) state.settings = { threshold: 0.32 };
        forceNextSave = true;
        persistNow();
        selectedId = null;
        graph.setData(state.nodes, state.synapses, state.domains);
        graph.setSelected(null);
        graph.setInset(0);
        graph.fit();
        renderAll();
        toast('已导入 ' + state.nodes.length + ' 条记忆', 'good');
      } catch (err) {
        toast('导入失败：文件格式不对', 'warn');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  function fmtDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent('hippocampus:' + name, { detail }));
    } catch (e) { /* ignore */ }
  }

  window.Hippocampus = {
    state: () => state,
    addMemory: (input) => {
      const node = Model.addMemory(state, input, Date.now());
      graph.setData(state.nodes, state.synapses, state.domains, { settle: false });
      save(true);
      renderAll();
      return node;
    },
    recall: (id) => doRecall(id),
    search: (q) => {
      applySearch(q);
      return searchIds ? [...searchIds] : [];
    },
    proposals: (opts) => Model.proposals(state, Object.assign({ now: Date.now() }, opts)),
    connect: (aId, bId) => {
      const a = Model.findNode(state, aId);
      const b = Model.findNode(state, bId);
      if (a && b) connect(a, b);
    },
    fit: () => graph.fit(),
    focus: (id) => select(id, { focus: true }),
    graph: () => graph,
    timeTravel: (days) => setTimeOffset(days),
    on: (name, cb) => window.addEventListener('hippocampus:' + name, cb)
  };
})();
