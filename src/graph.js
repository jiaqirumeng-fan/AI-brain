/* 海马体 · 可视化引擎
   Canvas 力导向「脑叶」布局：领域成团、跨域成桥、亮度即可提取度。 */
(function (global) {
  'use strict';

  const HU = global.HU;
  const Model = global.Model;
  const TAU = Math.PI * 2;

  function rgba(hex, a) {
    let h = String(hex || '#7aa2ff').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function bezier(A, C, B, t) {
    const mt = 1 - t;
    return {
      x: mt * mt * A.x + 2 * mt * t * C.x + t * t * B.x,
      y: mt * mt * A.y + 2 * mt * t * C.y + t * t * B.y
    };
  }

  class BrainGraph {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts || {};
      this.nodes = [];
      this.synapses = [];
      this.domains = [];
      this.nodeMap = new Map();
      this.domainMap = new Map();
      this.centers = new Map();

      this.cam = { scale: 1, tx: 0, ty: 0 };
      this.camTarget = null;
      this.insetRight = 0;

      this.alpha = 1;
      this.time = 0;
      this.dpr = Math.min(2, global.devicePixelRatio || 1);

      this.selectedId = null;
      this.hoverId = null;
      this.searchIds = null;
      this.filterDomain = null;
      this.globalView = false;
      this.timeOffsetDays = 0;

      this.pulses = [];
      this.ripples = [];
      this.floaters = [];
      this.echoes = [];
      this.linking = null;

      this.pointer = {
        down: false, moved: false, startX: 0, startY: 0,
        node: null, dragNode: null, dragOffset: { x: 0, y: 0 }, panStart: null
      };

      this._bind();
      this._resize();
      this._last = performance.now();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    /* ─────────── 数据 ─────────── */
    now() { return Date.now() + this.timeOffsetDays * HU.DAY; }

    setData(nodes, synapses, domains, opts) {
      this.nodes = nodes;
      this.synapses = synapses;
      this.domains = domains;
      this.nodeMap = new Map(nodes.map((n) => [n.id, n]));
      this.domainMap = new Map(domains.map((d) => [d.id, d]));
      this._layoutCenters();
      this._place();
      const settle = !opts || opts.settle !== false;
      if (settle) {
        this.alpha = 1;
        // 预先收敛，打开就是稳定的形状，避免镜头来回跳
        for (let i = 0; i < 280; i++) this._step();
        this.alpha = 0.22;
      } else {
        this.alpha = Math.max(this.alpha, 0.5);
      }
    }

    _layoutCenters() {
      this.centers = new Map();
      const n = Math.max(1, this.domains.length);
      const RX = 520, RY = 258;
      this.domains.forEach((d, i) => {
        const a = -Math.PI / 2 + (i / n) * TAU + 0.1;
        this.centers.set(d.id, { x: Math.cos(a) * RX, y: Math.sin(a) * RY, angle: a });
      });
    }

    _place() {
      for (const n of this.nodes) {
        if (!isFinite(n.x) || !isFinite(n.y)) {
          const c = this.centers.get(n.domain) || { x: 0, y: 0 };
          const rnd = HU.rand(n.id);
          const a = rnd() * TAU;
          const r = 30 + rnd() * 120;
          n.x = c.x + Math.cos(a) * r;
          n.y = c.y + Math.sin(a) * r;
        }
        if (!isFinite(n.vx)) n.vx = 0;
        if (!isFinite(n.vy)) n.vy = 0;
        n._r = 8.5 + 12 * HU.clamp(n.importance == null ? 0.6 : n.importance, 0, 1);
      }
    }

    /* ─────────── 视口 ─────────── */
    _resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.w = Math.max(1, rect.width);
      this.h = Math.max(1, rect.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    worldToScreen(x, y) {
      return { x: x * this.cam.scale + this.cam.tx, y: y * this.cam.scale + this.cam.ty };
    }
    screenToWorld(x, y) {
      return { x: (x - this.cam.tx) / this.cam.scale, y: (y - this.cam.ty) / this.cam.scale };
    }

    setCamera(cam, animate) {
      if (animate) this.camTarget = { scale: cam.scale, tx: cam.tx, ty: cam.ty };
      else { this.cam = { scale: cam.scale, tx: cam.tx, ty: cam.ty }; this.camTarget = null; }
    }

    fit(padding, immediate) {
      if (!this.nodes.length) return;
      padding = padding == null ? 44 : padding;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of this.nodes) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const bw = Math.max(1, maxX - minX + 100);
      const bh = Math.max(1, maxY - minY + 100);
      const availW = this.w - this.insetRight - padding * 2;
      const availH = this.h - 96;
      const s = HU.clamp(Math.min(availW / bw, availH / bh), 0.4, 1.35);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      this.setCamera({
        scale: s,
        tx: (this.w - this.insetRight) / 2 - cx * s,
        ty: this.h / 2 + 6 - cy * s
      }, !immediate);
    }

    focusNode(id, scale) {
      const n = this.nodeMap.get(id);
      if (!n) return;
      const s = scale || Math.max(this.cam.scale, 0.92);
      this.setCamera({
        scale: s,
        tx: (this.w - this.insetRight) / 2 - n.x * s,
        ty: this.h / 2 - n.y * s
      }, true);
    }

    ensureVisible(id) {
      const n = this.nodeMap.get(id);
      if (!n) return;
      const p = this.worldToScreen(n.x, n.y);
      const maxX = this.w - this.insetRight - 48;
      if (p.x > maxX || p.x < 48 || p.y < 96 || p.y > this.h - 96) this.focusNode(id);
    }

    zoomBy(f) {
      const cx = (this.w - this.insetRight) / 2;
      const cy = this.h / 2;
      const world = this.screenToWorld(cx, cy);
      const ns = HU.clamp(this.cam.scale * f, 0.28, 2.8);
      this.setCamera({ scale: ns, tx: cx - world.x * ns, ty: cy - world.y * ns }, false);
    }

    setInset(px) { this.insetRight = px; }

    setSelected(id) { this.selectedId = id; }
    setSearch(ids) { this.searchIds = ids ? new Set(ids) : null; }
    setFilter(domainId) { this.filterDomain = domainId || null; }
    setGlobalView(v) { this.globalView = !!v; }
    setTimeOffset(days) { this.timeOffsetDays = days || 0; }

    /* ─────────── 指针 ─────────── */
    _local(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _hit(x, y) {
      const w = this.screenToWorld(x, y);
      let best = null, bestD = Infinity;
      for (const n of this.nodes) {
        const d = Math.hypot(n.x - w.x, n.y - w.y);
        if (d < n._r + 9 && d < bestD) { best = n; bestD = d; }
      }
      return best;
    }

    _bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this._down(e));
      global.addEventListener('pointermove', (e) => this._move(e));
      global.addEventListener('pointerup', (e) => this._up(e));
      c.addEventListener('dblclick', (e) => {
        const p = this._local(e);
        const n = this._hit(p.x, p.y);
        if (n && this.opts.onRecall) this.opts.onRecall(n);
      });
      c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      c.addEventListener('pointerleave', () => {
        if (this.pointer.down) return;
        if (this.hoverId) {
          this.hoverId = null;
          c.classList.remove('over-node');
          if (this.opts.onHover) this.opts.onHover(null);
        }
      });
      if (global.ResizeObserver) {
        new ResizeObserver(() => this._resize()).observe(c);
      } else {
        global.addEventListener('resize', () => this._resize());
      }
      global.addEventListener('resize', () => this._resize());
    }

    _wheel(e) {
      e.preventDefault();
      const p = this._local(e);
      const world = this.screenToWorld(p.x, p.y);
      const ns = HU.clamp(this.cam.scale * Math.exp(-e.deltaY * 0.0012), 0.28, 2.8);
      this.cam = { scale: ns, tx: p.x - world.x * ns, ty: p.y - world.y * ns };
      this.camTarget = null;
    }

    _down(e) {
      if (e.button !== 0) return;
      const p = this._local(e);
      const n = this._hit(p.x, p.y);
      this.pointer.down = true;
      this.pointer.moved = false;
      this.pointer.startX = p.x;
      this.pointer.startY = p.y;
      this.pointer.node = n;
      this.pointer.dragNode = null;
      this.pointer.panStart = null;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

      if (n) {
        if (e.shiftKey) {
          this.linking = { from: n, x: p.x, y: p.y };
          this.canvas.classList.add('linking');
        } else {
          this.pointer.dragNode = n;
          const w = this.screenToWorld(p.x, p.y);
          this.pointer.dragOffset = { x: n.x - w.x, y: n.y - w.y };
          this.alpha = Math.max(this.alpha, 0.18);
        }
      } else {
        this.pointer.panStart = { x: p.x, y: p.y, tx: this.cam.tx, ty: this.cam.ty };
        this.canvas.classList.add('dragging');
      }
    }

    _move(e) {
      if (this.linking) {
        const p = this._local(e);
        this.linking.x = p.x;
        this.linking.y = p.y;
        return;
      }
      if (this.pointer.down) {
        const p = this._local(e);
        if (Math.hypot(p.x - this.pointer.startX, p.y - this.pointer.startY) > 4) this.pointer.moved = true;

        if (this.pointer.dragNode) {
          const w = this.screenToWorld(p.x, p.y);
          const n = this.pointer.dragNode;
          n.x = w.x + this.pointer.dragOffset.x;
          n.y = w.y + this.pointer.dragOffset.y;
          n.vx = n.vy = 0;
          this.alpha = Math.max(this.alpha, 0.22);
        } else if (this.pointer.panStart) {
          this.cam.tx = this.pointer.panStart.tx + (p.x - this.pointer.panStart.x);
          this.cam.ty = this.pointer.panStart.ty + (p.y - this.pointer.panStart.y);
          this.camTarget = null;
        }
        return;
      }

      const p = this._local(e);
      if (p.x < 0 || p.y < 0 || p.x > this.w || p.y > this.h) return;
      const n = this._hit(p.x, p.y);
      if ((n && n.id) !== this.hoverId) {
        this.hoverId = n ? n.id : null;
        this.canvas.classList.toggle('over-node', !!n);
        if (this.opts.onHover) {
          if (n) {
            const s = this.worldToScreen(n.x, n.y);
            const r = this.canvas.getBoundingClientRect();
            this.opts.onHover(n, { x: r.left + s.x, y: r.top + s.y });
          } else {
            this.opts.onHover(null);
          }
        }
      }
    }

    _up(e) {
      if (!this.pointer.down && !this.linking) return;
      const p = this._local(e);
      if (this.linking) {
        const target = this._hit(p.x, p.y);
        const from = this.linking.from;
        this.linking = null;
        this.canvas.classList.remove('linking');
        if (target && target.id !== from.id && this.opts.onManualLink) this.opts.onManualLink(from, target);
      } else if (this.pointer.dragNode) {
        const n = this.pointer.dragNode;
        if (!this.pointer.moved && this.opts.onSelect) this.opts.onSelect(n);
      } else if (this.pointer.panStart && !this.pointer.moved) {
        if (this.opts.onSelect) this.opts.onSelect(null);
      }
      this.pointer.down = false;
      this.pointer.node = null;
      this.pointer.dragNode = null;
      this.pointer.panStart = null;
      this.canvas.classList.remove('dragging');
    }

    /* ─────────── 物理 ─────────── */
    _step() {
      const nodes = this.nodes;
      const now = this.now();
      const a = HU.clamp(this.alpha, 0, 1);
      for (const n of nodes) { n.fx = 0; n.fy = 0; }

      for (let i = 0; i < nodes.length; i++) {
        const A = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const B = nodes[j];
          let dx = B.x - A.x, dy = B.y - A.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > 300000) continue;
          let d = Math.sqrt(d2);
          if (d < 6) {
            dx = (Math.random() - 0.5) * 4;
            dy = (Math.random() - 0.5) * 4;
            d = 6; d2 = 36;
          }
          const f = 7600 / d2;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          A.fx -= fx; A.fy -= fy;
          B.fx += fx; B.fy += fy;
        }
      }

      for (const s of this.synapses) {
        const A = this.nodeMap.get(s.source);
        const B = this.nodeMap.get(s.target);
        if (!A || !B) continue;
        const w = Model.synapseWeight(s, now);
        const cross = A.domain !== B.domain;
        let dx = B.x - A.x, dy = B.y - A.y;
        const d = Math.hypot(dx, dy) || 1;
        const L = cross ? 138 + 74 * (1 - w) : 80 + 58 * (1 - w);
        const f = (d - L) * 0.012 * (0.35 + 0.65 * w) * (cross ? 0.5 : 1);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        A.fx += fx; A.fy += fy;
        B.fx -= fx; B.fy -= fy;
      }

      for (const n of nodes) {
        const c = this.centers.get(n.domain);
        if (c) {
          n.fx += (c.x - n.x) * 0.0046;
          n.fy += (c.y - n.y) * 0.0046;
        }
        n.fx += -n.x * 0.0009;
        n.fy += -n.y * 0.0009;

        n.vx = (n.vx + n.fx * (0.55 + 0.45 * a)) * 0.84;
        n.vy = (n.vy + n.fy * (0.55 + 0.45 * a)) * 0.84;
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > 6) { n.vx *= 6 / sp; n.vy *= 6 / sp; }
        n.x += n.vx;
        n.y += n.vy;
      }

      // 碰撞分离
      for (let i = 0; i < nodes.length; i++) {
        const A = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const B = nodes[j];
          const dx = B.x - A.x, dy = B.y - A.y;
          const d = Math.hypot(dx, dy) || 1;
          const min = A._r + B._r + 14;
          if (d < min) {
            const push = (min - d) / 2;
            const ux = dx / d, uy = dy / d;
            A.x -= ux * push; A.y -= uy * push;
            B.x += ux * push; B.y += uy * push;
          }
        }
      }
      this.alpha *= 0.986;
      if (this.alpha < 0.004) this.alpha = 0;
    }

    /* ─────────── 动画反馈 ─────────── */
    pulseFrom(id) {
      const node = this.nodeMap.get(id);
      if (!node) return;
      const t0 = performance.now();
      this.ripples.push({ id, t0, dur: 900 });
      let i = 0;
      for (const s of this.synapses) {
        if (s.source !== id && s.target !== id) continue;
        if (Model.synapseWeight(s, this.now()) < 0.07) continue;
        this.pulses.push({ syn: s, from: id, t0: t0 + (i++) * 70, dur: 680 });
        const other = s.source === id ? s.target : s.source;
        this.echoes.push({ id: other, t0: t0 + 160 + i * 60, dur: 820 });
      }
    }

    synapseBorn(syn) {
      syn._birthAt = performance.now();
    }

    floater(id, text, tone) {
      const n = this.nodeMap.get(id);
      if (!n) return;
      this.floaters.push({ x: n.x, y: n.y, text, tone: tone || 'up', t0: performance.now(), dur: 1900 });
    }

    /* ─────────── 主循环 ─────────── */
    _loop(ts) {
      const dt = Math.min(60, ts - this._last || 16);
      this._last = ts;
      this.time += dt;

      if (this.camTarget) {
        const t = this.camTarget;
        const k = 0.16;
        this.cam.scale += (t.scale - this.cam.scale) * k;
        this.cam.tx += (t.tx - this.cam.tx) * k;
        this.cam.ty += (t.ty - this.cam.ty) * k;
        if (Math.abs(t.scale - this.cam.scale) < 0.002 &&
            Math.abs(t.tx - this.cam.tx) < 0.5 && Math.abs(t.ty - this.cam.ty) < 0.5) {
          this.cam = { scale: t.scale, tx: t.tx, ty: t.ty };
          this.camTarget = null;
        }
      }

      if (this.alpha > 0.004) this._step();
      this._draw(ts);
      requestAnimationFrame(this._loop);
    }

    _focusSets() {
      const focus = this.selectedId || this.hoverId;
      if (!focus) return null;
      const set = new Set([focus]);
      const now = this.now();
      for (const s of this.synapses) {
        if (Model.synapseWeight(s, now) < 0.05) continue;
        if (s.source === focus) set.add(s.target);
        if (s.target === focus) set.add(s.source);
      }
      return set;
    }

    _draw(ts) {
      const ctx = this.ctx;
      const now = this.now();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);

      this._drawNebula(ctx);
      this._drawEdges(ctx, now, ts);
      this._drawNodes(ctx, now, ts);
      this._drawLabels(ctx, now);
      this._drawOverlays(ctx, now, ts);
    }

    _drawNebula(ctx) {
      const s = this.cam.scale;
      for (const d of this.domains) {
        const c = this.centers.get(d.id);
        if (!c) continue;
        const p = this.worldToScreen(c.x, c.y);
        const R = 265 * s;
        if (p.x < -R || p.y < -R || p.x > this.w + R || p.y > this.h + R) continue;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
        g.addColorStop(0, rgba(d.color, 0.085));
        g.addColorStop(0.45, rgba(d.color, 0.04));
        g.addColorStop(1, rgba(d.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, R, 0, TAU);
        ctx.fill();

        // 脑区边界
        ctx.save();
        ctx.setLineDash([2 * s, 8 * s]);
        ctx.strokeStyle = rgba(d.color, 0.075);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 188 * s, 0, TAU);
        ctx.stroke();
        ctx.restore();

        // 脑区名交给侧栏图例，画布上保持干净
      }
    }

    _bridgeNodes(now) {
      const set = new Set();
      for (const s of this.synapses) {
        const A = this.nodeMap.get(s.source);
        const B = this.nodeMap.get(s.target);
        if (!A || !B || A.domain === B.domain) continue;
        if (Model.synapseWeight(s, now) < 0.06) continue;
        set.add(A.id); set.add(B.id);
      }
      return set;
    }

    _drawEdges(ctx, now, ts) {
      const focus = this.selectedId || this.hoverId;
      const focusSet = this._focusSets();
      const s = this.cam.scale;

      ctx.save();
      ctx.translate(this.cam.tx, this.cam.ty);
      ctx.scale(s, s);

      for (const syn of this.synapses) {
        const A = this.nodeMap.get(syn.source);
        const B = this.nodeMap.get(syn.target);
        if (!A || !B) continue;
        const w = Model.synapseWeight(syn, now);
        if (w < 0.055) continue;

        const da = this.domainMap.get(A.domain);
        const db = this.domainMap.get(B.domain);
        const isCross = A.domain !== B.domain;

        let alpha = isCross ? 0.1 + 0.55 * w : 0.05 + 0.38 * w;
        if (this.globalView && !isCross) alpha *= 0.08;
        if (focusSet && !(focusSet.has(A.id) && focusSet.has(B.id))) alpha *= 0.2;
        if (this.searchIds && !(this.searchIds.has(A.id) || this.searchIds.has(B.id))) alpha *= 0.2;
        if (this.filterDomain && A.domain !== this.filterDomain && B.domain !== this.filterDomain) alpha *= 0.15;
        if (syn.nascent) alpha *= 0.75;

        const mx = (A.x + B.x) / 2;
        const my = (A.y + B.y) / 2;
        const dx = B.x - A.x, dy = B.y - A.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = (HU.hashString(syn.id) % 2 ? 1 : -1) * 0.1 * len;
        const cx = mx + (-dy / len) * bend;
        const cy = my + (dx / len) * bend;

        let stroke;
        if (isCross) {
          const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y);
          g.addColorStop(0, rgba(da ? da.color : '#7aa2ff', alpha));
          g.addColorStop(1, rgba(db ? db.color : '#9df5d5', alpha));
          stroke = g;
        } else {
          stroke = rgba(da ? da.color : '#7aa2ff', alpha);
        }

        const connected = focusSet && (A.id === focus || B.id === focus);

        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.quadraticCurveTo(cx, cy, B.x, B.y);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.7 + 2.3 * w;
        if (syn.nascent) ctx.setLineDash([2.5, 5]);
        else ctx.setLineDash([]);
        if (connected && w > 0.2) {
          ctx.shadowColor = rgba(isCross ? '#9df5d5' : (da ? da.color : '#7aa2ff'), 0.55);
          ctx.shadowBlur = 9;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);

        if (connected && w > 0.2) {
          ctx.save();
          ctx.strokeStyle = rgba('#cfe0ff', 0.5);
          ctx.lineWidth = 1.1;
          ctx.setLineDash([3, 9]);
          ctx.lineDashOffset = -(performance.now() * 0.018) % 12;
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.quadraticCurveTo(cx, cy, B.x, B.y);
          ctx.stroke();
          ctx.restore();
        }

        // 新生突触：从一端生长出来
        if (syn._birthAt) {
          const p = HU.clamp((performance.now() - syn._birthAt) / 850, 0, 1);
          if (p < 1) {
            ctx.beginPath();
            const steps = 16;
            for (let i = 0; i <= steps * p; i++) {
              const t = i / steps;
              const pt = bezier(A, { x: cx, y: cy }, B, t);
              if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
            }
            ctx.strokeStyle = rgba('#eaf6ff', 0.85);
            ctx.lineWidth = 2.4;
            ctx.shadowColor = 'rgba(180, 230, 255, .9)';
            ctx.shadowBlur = 14;
            ctx.stroke();
            const tip = bezier(A, { x: cx, y: cy }, B, p);
            ctx.beginPath();
            ctx.fillStyle = '#eaf6ff';
            ctx.arc(tip.x, tip.y, 3.2, 0, TAU);
            ctx.fill();
            ctx.shadowBlur = 0;
          } else {
            delete syn._birthAt;
          }
        }

        // 信号脉冲
        for (const pulse of this.pulses) {
          if (pulse.syn !== syn) continue;
          const t = (performance.now() - pulse.t0) / pulse.dur;
          if (t < 0 || t > 1) continue;
          const rev = pulse.from === syn.target;
          const a = rev ? B : A;
          const b = rev ? A : B;
          const pt = bezier(a, { x: cx, y: cy }, b, t);
          const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, 9);
          grad.addColorStop(0, 'rgba(235, 248, 255, .95)');
          grad.addColorStop(0.4, 'rgba(160, 220, 255, .55)');
          grad.addColorStop(1, 'rgba(120, 200, 255, 0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 9, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    _drawNodes(ctx, now, ts) {
      const focusSet = this._focusSets();
      const bridgeNodes = this.globalView ? this._bridgeNodes(now) : null;
      const s = this.cam.scale;
      const t = ts / 1000;

      for (const n of this.nodes) {
        const d = this.domainMap.get(n.domain);
        const color = d ? d.color : '#7aa2ff';
        const r = n._r;
        const vis = Model.visual(n, now);
        let mul = 1;
        if (this.filterDomain && n.domain !== this.filterDomain) mul *= 0.15;
        if (this.searchIds && !this.searchIds.has(n.id)) mul *= 0.13;
        if (focusSet && !focusSet.has(n.id)) mul *= 0.28;
        if (bridgeNodes && !bridgeNodes.has(n.id)) mul *= 0.18;

        const p = this.worldToScreen(n.x, n.y);
        const sr = Math.max(3.2, r * s);
        if (p.x < -80 || p.y < -80 || p.x > this.w + 80 || p.y > this.h + 80) continue;

        const alpha = (0.35 + 0.65 * vis) * mul;
        const glowR = sr * (2.2 + 1.0 * vis);

        const g = ctx.createRadialGradient(p.x, p.y, sr * 0.15, p.x, p.y, glowR);
        g.addColorStop(0, rgba(color, 0.27 * vis * mul));
        g.addColorStop(0.4, rgba(color, 0.1 * vis * mul));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowR, 0, TAU);
        ctx.fill();

        const breath = vis > 0.65 ? 1 + Math.sin(t * 1.4 + HU.hashString(n.id) % 6) * 0.035 : 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sr * breath, 0, TAU);

        if (vis < 0.38) {
          ctx.fillStyle = rgba(color, 0.1 * mul);
          ctx.fill();
          ctx.setLineDash([2, 3.5]);
          ctx.strokeStyle = rgba(color, 0.6 * mul);
          ctx.lineWidth = 1.1;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = rgba(color, alpha);
          ctx.fill();
          const hl = ctx.createRadialGradient(
            p.x - sr * 0.3, p.y - sr * 0.35, 0,
            p.x - sr * 0.3, p.y - sr * 0.35, sr * 1.1
          );
          hl.addColorStop(0, 'rgba(255,255,255,' + (0.3 * vis * mul) + ')');
          hl.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = hl;
          ctx.beginPath();
          ctx.arc(p.x, p.y, sr * breath, 0, TAU);
          ctx.fill();
        }

        // 激活回声
        for (const e of this.echoes) {
          if (e.id !== n.id) continue;
          const k = HU.clamp((performance.now() - e.t0) / e.dur, 0, 1);
          if (k >= 1) continue;
          ctx.beginPath();
          ctx.arc(p.x, p.y, sr + 6 + 18 * k, 0, TAU);
          ctx.strokeStyle = rgba('#dff0ff', (1 - k) * 0.5);
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }

        if (this.selectedId === n.id) {
          const rot = (performance.now() * 0.00025) % TAU;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(rot);
          ctx.setLineDash([3, 5]);
          ctx.strokeStyle = 'rgba(207, 224, 255, .8)';
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.arc(0, 0, sr + 8, 0, TAU);
          ctx.stroke();
          ctx.restore();
          ctx.setLineDash([]);
        } else if (this.hoverId === n.id) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, sr + 6, 0, TAU);
          ctx.strokeStyle = 'rgba(215, 232, 255, .45)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    _labelFree(o, boxes, self, scale) {
      for (const b of boxes) {
        if (o.bx < b.x + b.w + 4 && o.bx + o.bw > b.x - 4 && o.by < b.y + b.h + 4 && o.by + o.bh > b.y - 4) return false;
      }
      for (const m of this.nodes) {
        if (m.id === self.id) continue;
        const p = this.worldToScreen(m.x, m.y);
        const r = Math.max(3.2, m._r * scale) + 4;
        const cx = HU.clamp(p.x, o.bx, o.bx + o.bw);
        const cy = HU.clamp(p.y, o.by, o.by + o.bh);
        if (Math.hypot(p.x - cx, p.y - cy) < r) return false;
      }
      return true;
    }

    _drawLabels(ctx, now) {
      const focusSet = this._focusSets();
      const bridgeNodes = this.globalView ? this._bridgeNodes(now) : null;
      const s = this.cam.scale;
      const boxes = [];
      const items = this.nodes.slice().sort((a, b) => {
        const ra = (a.id === this.selectedId ? 3 : a.id === this.hoverId ? 2 : Model.visual(a, now));
        const rb = (b.id === this.selectedId ? 3 : b.id === this.hoverId ? 2 : Model.visual(b, now));
        return rb - ra;
      });

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      let shown = 0;
      const maxLabels = s < 0.62 ? 10 : s < 0.8 ? 18 : 26;

      for (const n of items) {
        const vis = Model.visual(n, now);
        const isFocus = n.id === this.selectedId || n.id === this.hoverId;
        const isMatch = this.searchIds && this.searchIds.has(n.id);
        const d = this.domainMap.get(n.domain);
        const degree = this.synapses.filter((x) => x.source === n.id || x.target === n.id).length;

        let show = isFocus || isMatch;
        if (!show) {
          if (bridgeNodes && !bridgeNodes.has(n.id)) show = false;
          else if (this.filterDomain && n.domain !== this.filterDomain) show = false;
          else show = (vis > 0.54 && s > 0.55) || (degree >= 5 && vis > 0.38 && s > 0.5);
        }
        if (!show) continue;
        if (!isFocus && !isMatch && shown >= maxLabels) continue;
        shown++;

        const p = this.worldToScreen(n.x, n.y);
        const sr = Math.max(3.2, n._r * s);
        const fs = isFocus ? 12.5 : 10.5;
        ctx.font = (isFocus ? '600 ' : '500 ') + fs + 'px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        const text = n.title;
        const tw = ctx.measureText(text).width;
        const pad = 4;
        const opts = [
          { x: p.x, y: p.y + sr + 10, align: 'center', bx: p.x - tw / 2 - pad, by: p.y + sr + 7, bw: tw + pad * 2, bh: fs + 6 },
          { x: p.x, y: p.y - sr - fs - 8, align: 'center', bx: p.x - tw / 2 - pad, by: p.y - sr - fs - 11, bw: tw + pad * 2, bh: fs + 6 },
          { x: p.x + sr + 9, y: p.y - fs / 2 - 1, align: 'left', bx: p.x + sr + 7, by: p.y - fs / 2 - 3, bw: tw + pad * 2, bh: fs + 6 }
        ];
        let chosen = null;
        for (const o of opts) {
          if (this._labelFree(o, boxes, n, s)) { chosen = o; break; }
        }
        if (!chosen) {
          if (!isFocus && !isMatch) continue;
          chosen = opts[0];
        }
        boxes.push({ x: chosen.bx, y: chosen.by, w: chosen.bw, h: chosen.bh });
        ctx.textAlign = chosen.align;

        let alpha = 0.55 + 0.4 * vis;
        if (this.searchIds && !isMatch) alpha *= 0.25;
        if (focusSet && !focusSet.has(n.id)) alpha *= 0.4;
        if (this.filterDomain && n.domain !== this.filterDomain) alpha *= 0.2;
        if (d) ctx.fillStyle = rgba(d.color, Math.min(0.95, alpha));
        else ctx.fillStyle = 'rgba(220, 232, 250, ' + alpha + ')';

        ctx.shadowColor = 'rgba(0,0,0,.85)';
        ctx.shadowBlur = 5;
        ctx.fillText(text, chosen.x, chosen.y);
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }

    _drawOverlays(ctx, now, ts) {
      // 拖动连线
      if (this.linking) {
        const n = this.linking.from;
        const p = this.worldToScreen(n.x, n.y);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(this.linking.x, this.linking.y);
        ctx.strokeStyle = 'rgba(180, 220, 255, .75)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.lineDashOffset = -(performance.now() * 0.03) % 10;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(this.linking.x, this.linking.y, 4, 0, TAU);
        ctx.fillStyle = '#dff0ff';
        ctx.fill();
        ctx.restore();
      }

      // 回想波纹
      for (const r of this.ripples) {
        const k = (performance.now() - r.t0) / r.dur;
        if (k < 0 || k > 1) continue;
        const n = this.nodeMap.get(r.id);
        if (!n) continue;
        const p = this.worldToScreen(n.x, n.y);
        const rad = (n._r * this.cam.scale) + 10 + 120 * k;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, TAU);
        ctx.strokeStyle = 'rgba(190, 225, 255, ' + (1 - k) * 0.55 + ')';
        ctx.lineWidth = 1.6 * (1 - k) + 0.4;
        ctx.stroke();
      }

      // 飘字
      for (const f of this.floaters) {
        const k = (performance.now() - f.t0) / f.dur;
        if (k < 0 || k > 1) continue;
        const n = { x: f.x, y: f.y };
        const p = this.worldToScreen(n.x, n.y);
        const sr = 12;
        const alpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.55) / 0.45);
        ctx.save();
        ctx.globalAlpha = HU.clamp(alpha, 0, 1);
        ctx.font = '600 11.5px "Segoe UI", "Microsoft YaHei UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(f.text).width;
        const y = p.y - sr - 16 - 26 * k;
        ctx.fillStyle = 'rgba(9, 14, 24, .84)';
        const pad = 7;
        const bx = p.x - w / 2 - pad, by = y - 10, bw = w + pad * 2, bh = 20;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6);
        else ctx.rect(bx, by, bw, bh);
        ctx.fill();
        ctx.strokeStyle = f.tone === 'bridge' ? 'rgba(157,245,213,.45)' : 'rgba(160,200,255,.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = f.tone === 'bridge' ? '#9df5d5' : '#dbe9ff';
        ctx.fillText(f.text, p.x, y);
        ctx.restore();
      }

      // 清理过期动画
      const tn = performance.now();
      this.pulses = this.pulses.filter((p) => tn - p.t0 < p.dur + 120);
      this.ripples = this.ripples.filter((r) => tn - r.t0 < r.dur + 80);
      this.floaters = this.floaters.filter((f) => tn - f.t0 < f.dur + 80);
      this.echoes = this.echoes.filter((e) => tn - e.t0 < e.dur + 80);
    }
  }

  global.BrainGraph = BrainGraph;
})(typeof window !== 'undefined' ? window : globalThis);
