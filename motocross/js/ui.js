/* =====================================================================
   ROOST MX - menus: main menu, bike & track selection, garage, settings,
   controls and pause. Mouse, keyboard and gamepad navigation.
   ===================================================================== */
MX.module('ui', function (THREE, MX) {
  'use strict';
  const { clamp } = MX;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PALETTE = ['#ff7a00', '#e5262b', '#1d6cff', '#22b14c', '#ffd23f', '#f2f2f2', '#1a1a1a', '#7c3aed', '#00b8d9', '#ff4fa3', '#8a6c52', '#6b7280'];
  const DARKS = ['#1b1d22', '#1a1a1a', '#2b2e33', '#3a3d43', '#0d2a6b', '#5a1010', '#2a3a1a', '#f2f2f2', '#9aa0a8', '#c9a03a'];

  class UI {
    constructor(game) {
      this.game = game;
      this.stack = [];
      this.current = null;
      this.tabs = { garage: 'paint', settings: 'graphics' };
      this.focusEl = null;
      this._wire();
    }

    get S() { return this.game.settings; }
    get G() { return this.game.garage; }

    // ------------------------------------------------------------ screens
    show(id, push) {
      const prev = this.current;
      if (push && prev && prev !== id) this.stack.push(prev);
      document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
      this.current = id;
      const r = this['render_' + id];
      if (r) r.call(this);
      this.game.onScreen(id);
      this._focusFirst();
    }
    hideAll() { document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active')); this.current = null; this.stack.length = 0; this._setFocus(null); }
    back() {
      if (this.capturing) return;
      const prev = this.stack.pop();
      this.game.audio.ui('back');
      if (prev) this.show(prev);
      else if (this.current === 'pause') this.game.resume();
      else if (this.current && this.current !== 'menu') this.show(this.game.state === 'paused' ? 'pause' : 'menu');
    }

    _wire() {
      document.addEventListener('click', (e) => {
        const t = e.target.closest('button, [data-bike], [data-track]');
        if (!t || this.capturing) return;
        this.game.audio.unlock();
        this._click(t, e);
      });
      document.addEventListener('input', (e) => this._input(e.target));
      document.addEventListener('change', (e) => this._input(e.target, true));
      document.addEventListener('mouseover', (e) => {
        const t = e.target.closest('.screen.active button, .screen.active input[type=range]');
        if (t && t !== this.focusEl) { this._setFocus(t, true); }
      });
    }

    _click(t, e) {
      const d = t.dataset;
      const game = this.game;
      if ('back' in d) { this.back(); return; }
      if (d.goto) { game.audio.ui('select'); this.show(d.goto, true); return; }
      if (d.action) { game.audio.ui('select'); game.action(d.action); return; }
      if (d.tab) {
        const group = t.closest('[data-tabs]').dataset.tabs;
        this.tabs[group] = d.tab; game.audio.ui('hover');
        this['render_' + group]();
        this._focusFirst(true);
        return;
      }
      if (d.bike) { this.selectBike(d.bike); return; }
      if (d.ride) { e.stopPropagation(); this.selectTrack(d.ride, true); return; }
      if (d.track) { this.selectTrack(d.track, this.game.state === 'paused'); return; }
      if (d.set) { this._setVal(d.set, d.val); game.audio.ui('hover'); this._refresh(); return; }
      if (d.tog) { this._setVal(d.tog, !this._getVal(d.tog)); game.audio.ui('hover'); this._refresh(); return; }
      if (d.look) { this._setLook(d.look, d.val); game.audio.ui('hover'); this.render_garage(); this._restoreFocus(t); return; }
      if (d.numstep) { const n = clamp((parseInt(this.G.look.number, 10) || 0) + (+d.numstep), 0, 999); this.G.look.number = String(n); MX.saveGarage(this.G); game.refreshLook(); this.render_garage(); this._restoreFocus(t); return; }
      if (d.key) { this._captureKey(d.key, +d.slot || 0); return; }
      if (d.padbind) { this._capturePad(d.padbind); return; }
      if (d.cmd) { this._cmd(d.cmd, t); return; }
    }

    _restoreFocus(old) {
      const sel = old.dataset.look ? `[data-look="${old.dataset.look}"][data-val="${old.dataset.val}"]` : old.dataset.numstep ? `[data-numstep="${old.dataset.numstep}"]` : null;
      const el = sel && document.querySelector('.screen.active ' + sel);
      if (el) this._setFocus(el);
    }

    _input(el, final) {
      const d = el.dataset;
      if (d.range) {
        const v = parseFloat(el.value);
        this._setVal(d.range, v);
        const out = el.parentElement.querySelector('.val');
        if (out) out.textContent = this._fmt(d.range, v);
        if (d.range.startsWith('audio.')) this.game.audio.applyVolumes();
      } else if (d.setup) {
        const bid = this.G.bike;
        const st = MX.setupFor(this.G, bid);
        st[d.setup] = parseFloat(el.value);
        this.G.setups[bid] = st; MX.saveGarage(this.G);
        const out = el.parentElement.querySelector('.val');
        if (out) out.textContent = this._fmtSetup(d.setup, st[d.setup]);
        if (final) this.game.refreshSetup();
      } else if (d.lookc) {
        this._setLook(d.lookc, el.value);
      } else if (d.num != null && el.type === 'text') {
        this.G.look.number = el.value.replace(/[^0-9]/g, '').slice(0, 3) || '0';
        MX.saveGarage(this.G); this.game.refreshLook();
      }
    }

    _setLook(key, val) {
      const G = this.G;
      if (MX.PAINT_KEYS.includes(key)) { G.paint[G.bike] = Object.assign({}, G.paint[G.bike] || {}, { [key]: val }); }
      else G.look[key] = val;
      MX.saveGarage(G);
      this.game.refreshLook();
    }

    _getVal(path) { return path.split('.').reduce((o, k) => o[k], this.S); }
    _setVal(path, v) {
      const ks = path.split('.'); let o = this.S;
      for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
      const old = o[ks[ks.length - 1]];
      if (typeof old === 'number' && typeof v === 'string' && v !== '' && !isNaN(+v)) v = +v;
      if (typeof old === 'boolean' && typeof v === 'string') v = v === 'true';
      o[ks[ks.length - 1]] = v;
      MX.saveSettings(this.S);
      this.game.applySettings(path);
    }
    _refresh() {
      const keep = this.focusEl && (this.focusEl.dataset.set ? `[data-set="${this.focusEl.dataset.set}"][data-val="${this.focusEl.dataset.val}"]` : this.focusEl.dataset.tog ? `[data-tog="${this.focusEl.dataset.tog}"]` : null);
      if (this.current === 'settings') this.render_settings();
      if (keep) { const el = document.querySelector('.screen.active ' + keep); if (el) this._setFocus(el); }
    }

    _fmt(path, v) {
      if (path.startsWith('audio.')) return Math.round(v * 100) + '%';
      if (path === 'graphics.resScale') return Math.round(v * 100) + '%';
      if (path === 'graphics.fov') return Math.round(v) + '°';
      if (path.includes('eadzone')) return Math.round(v * 100) + '%';
      return v.toFixed(2) + '×';
    }
    _fmtSetup(k, v) {
      if (k === 'sprocket') return v + 'T';
      return (v >= 1 ? '+' : '') + Math.round((v - 1) * 100) + '%';
    }

    // ------------------------------------------------------------ builders
    range(path, min, max, step, label, sub) {
      const v = this._getVal(path);
      return `<div class="frow"><label>${label}${sub ? `<small>${sub}</small>` : ''}</label><div class="ctl"><input type="range" data-range="${path}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="val">${this._fmt(path, v)}</span></div></div>`;
    }
    toggle(path, label, sub) {
      const v = this._getVal(path);
      return `<div class="frow"><label>${label}${sub ? `<small>${sub}</small>` : ''}</label><div class="ctl"><button class="tog ${v ? 'on' : ''}" data-tog="${path}" aria-pressed="${v}"></button></div></div>`;
    }
    seg(path, opts, label, sub) {
      const v = this._getVal(path);
      return `<div class="frow"><label>${label}${sub ? `<small>${sub}</small>` : ''}</label><div class="ctl"><div class="seg">${opts.map(([val, name]) => `<button data-set="${path}" data-val="${val}" class="${String(v) === String(val) ? 'on' : ''}">${name}</button>`).join('')}</div></div></div>`;
    }

    // ------------------------------------------------------------ main menu
    render_menu() {
      const b = MX.bikeById(this.G.bike), t = MX.trackById(this.G.track);
      const best = this.game.records[t.id + '|' + b.id];
      $('menu-play-sub').textContent = `${t.short} · ${b.name}`;
      const st = MX.bikeStats(b);
      $('menu-card').innerHTML = `<div class="cls">${esc(b.cls.toUpperCase())}</div><h3>${esc(b.name)}</h3>
        <div class="row"><span>Power</span><b>${st.powerHp.toFixed(0)} hp</b></div>
        <div class="row"><span>Weight</span><b>${b.mass} kg</b></div>
        <div class="row"><span>Track</span><b>${esc(t.name)}</b></div>
        <div class="row"><span>Best lap</span><b>${best ? MX.fmtLap(best) : '—'}</b></div>`;
      this.updatePadStatus();
    }
    updatePadStatus() {
      const el = $('pad-status');
      const p = this.game.input.padInfo();
      el.classList.toggle('on', !!p);
      el.textContent = p ? (p.kind === 'ps' ? 'PlayStation controller' : p.kind === 'xbox' ? 'Xbox controller' : 'Controller') + ' connected' : 'No controller (press a button to connect)';
    }

    // ------------------------------------------------------------ bikes
    render_bikes() {
      $('bike-list').innerHTML = MX.BIKES.map((b) => `<button class="bcard ${b.id === this.G.bike ? 'on' : ''}" data-bike="${b.id}" style="--c:${b.colors.plastics}"><h4>${esc(b.name)}</h4><span>${esc(b.cls.toUpperCase())}</span></button>`).join('');
      this._bikeInfo(MX.bikeById(this.G.bike));
    }
    _bikeInfo(b) {
      const st = MX.bikeStats(b);
      const bar = (name, v, txt) => `<div class="stat"><span>${name}</span><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div><b>${txt}</b></div>`;
      const ratios = MX.gearRatios(b);
      $('bike-info').innerHTML = `<div class="cls">${esc(b.cls.toUpperCase())}</div><h2>${esc(b.name)}</h2><p>${esc(b.desc)}</p>
        ${bar('Power', st.power, st.powerHp.toFixed(0) + ' hp')}
        ${bar('Torque', st.torque, st.torqueNm.toFixed(0) + ' Nm')}
        ${bar('Acceleration', st.accel, '')}
        ${bar('Top speed', st.speed, st.topKmh + ' km/h')}
        ${bar('Weight', st.weight, b.mass + ' kg')}
        ${bar('Handling', st.handling, '')}
        ${bar('Suspension', st.suspension, Math.round(b.susp.kR / 100) / 10 + ' N/mm')}
        <canvas class="torque-canvas" id="torque-canvas" width="460" height="110"></canvas>
        <div class="specs"><div><small>ENGINE</small><b>${b.cc}cc ${b.stroke}T</b></div><div><small>REDLINE</small><b>${(b.engine.limit / 1000).toFixed(1)}k</b></div><div><small>GEARS</small><b>${b.gears.length}-speed</b></div>
        <div><small>TRAVEL F/R</small><b>${Math.round(b.susp.travelF * 1000)}/${Math.round(b.susp.travelR * 1000)}</b></div><div><small>1ST GEAR</small><b>${b.gears[0]} km/h</b></div><div><small>FINAL</small><b>${ratios[0].toFixed(1)}:1</b></div></div>`;
      this._drawTorque($('torque-canvas'), b);
    }
    _drawTorque(cv, b) {
      if (!cv) return;
      const g = cv.getContext('2d'), w = cv.width, h = cv.height;
      g.clearRect(0, 0, w, h);
      const lim = b.engine.limit;
      let maxT = 0, maxP = 0;
      for (let r = 1000; r <= lim; r += 100) { const t = MX.curveSmooth(b.engine.torque, r); maxT = Math.max(maxT, t); maxP = Math.max(maxP, t * r); }
      const line = (fn, col, max) => { g.beginPath(); for (let r = 1000; r <= lim; r += 100) { const x = (r / lim) * (w - 20) + 10, y = h - 12 - (fn(r) / max) * (h - 26); r === 1000 ? g.moveTo(x, y) : g.lineTo(x, y); } g.strokeStyle = col; g.lineWidth = 2.5; g.stroke(); };
      line((r) => MX.curveSmooth(b.engine.torque, r), '#ffb347', maxT);
      line((r) => MX.curveSmooth(b.engine.torque, r) * r, '#ff7a00', maxP);
      g.fillStyle = '#9aa1ad'; g.font = '12px Barlow, sans-serif';
      g.fillText('torque', 12, 14); g.fillStyle = '#ff7a00'; g.fillText('power', 64, 14);
      g.fillStyle = '#9aa1ad'; g.fillText((lim / 1000).toFixed(1) + 'k rpm', w - 64, h - 2);
    }
    selectBike(id) {
      this.G.bike = id; MX.saveGarage(this.G);
      this.game.audio.ui('select');
      this.game.showroomBike();
      document.querySelectorAll('.bcard').forEach((c) => c.classList.toggle('on', c.dataset.bike === id));
      this._bikeInfo(MX.bikeById(id));
    }

    // ------------------------------------------------------------ tracks
    render_tracks() {
      $('track-grid').innerHTML = MX.TRACKS.map((t) => {
        const best = this.game.records[t.id + '|' + this.G.bike];
        const tr = this.game.trackCache(t.id);
        return `<div class="tcard ${t.id === this.G.track ? 'on' : ''}" data-track="${t.id}" tabindex="-1" role="button">
          <canvas width="420" height="210" data-map="${t.id}"></canvas>
          <div class="tc-body"><div class="kind">${esc(t.kind.toUpperCase())}</div><h4>${esc(t.name)}</h4><p>${esc(t.desc)}</p>
          <div class="meta"><span>Length <b>${(tr.length / 1000).toFixed(2)} km</b></span><span>Jumps <b>${tr.features.length}</b></span><span>Best <b>${best ? MX.fmtLap(best) : '—'}</b></span></div>
          <div style="margin-top:12px;display:flex;gap:8px"><button class="sbtn wide" data-ride="${t.id}">RIDE ›</button></div></div></div>`;
      }).join('');
      document.querySelectorAll('[data-map]').forEach((cv) => this._drawTrackMap(cv, this.game.trackCache(cv.dataset.map)));
    }
    _drawTrackMap(cv, tr) {
      const g = cv.getContext('2d'), w = cv.width, h = cv.height;
      const b = tr.bbox, pad = 22;
      const sx = Math.min((w - 2 * pad) / (b.maxx - b.minx), (h - 2 * pad) / (b.maxz - b.minz));
      const ox = w / 2 - ((b.minx + b.maxx) / 2) * sx, oz = h / 2 - ((b.minz + b.maxz) / 2) * sx;
      const T = (x, z) => [w - (x * sx + ox), z * sx + oz];
      let minH = Infinity, maxH = -Infinity;
      for (let i = 0; i < tr.n; i += 8) { minH = Math.min(minH, tr.base[i]); maxH = Math.max(maxH, tr.base[i]); }
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.lineWidth = 9; g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.beginPath(); for (let i = 0; i <= tr.n; i += 3) { const k = i % tr.n; const [x, y] = T(tr.px[k], tr.pz[k]); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
      for (let i = 0; i < tr.n; i += 3) {
        const k = i, k2 = (i + 3) % tr.n;
        const e = maxH > minH ? (tr.base[k] - minH) / (maxH - minH) : 0.5;
        g.strokeStyle = `hsl(${30 - e * 30}, 90%, ${55 + e * 15}%)`; g.lineWidth = 5;
        const [x0, y0] = T(tr.px[k], tr.pz[k]), [x1, y1] = T(tr.px[k2], tr.pz[k2]);
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      g.fillStyle = '#fff';
      for (const f of tr.features) { const p = tr.pointAt((f.s0 + f.s1) / 2); const [x, y] = T(p.x, p.z); g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
      const fp = tr.pointAt(tr.finishS); const [fx, fy] = T(fp.x, fp.z);
      g.fillStyle = '#111'; g.fillRect(fx - 6, fy - 6, 12, 12); g.fillStyle = '#fff'; g.fillRect(fx - 6, fy - 6, 6, 6); g.fillRect(fx, fy, 6, 6);
    }
    selectTrack(id, ride) {
      this.G.track = id; MX.saveGarage(this.G);
      this.game.audio.ui('select');
      document.querySelectorAll('.tcard').forEach((c) => c.classList.toggle('on', c.dataset.track === id));
      if (ride) this.game.startRace();
    }

    // ------------------------------------------------------------ garage
    render_garage() {
      const tab = this.tabs.garage;
      document.querySelectorAll('[data-tabs="garage"] .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
      const b = MX.bikeById(this.G.bike);
      $('garage-bike').textContent = b.name + ' · ' + b.cls;
      const L = MX.lookFor(this.G, b.id);
      const sw = (key, pal) => `<div class="swatches">${pal.map((c) => `<button class="sw ${L[key] === c ? 'on' : ''}" style="background:${c}" data-look="${key}" data-val="${c}" aria-label="${c}"></button>`).join('')}<input class="sw-custom" type="color" data-lookc="${key}" value="${L[key]}" title="Custom colour"></div>`;
      const row = (label, inner, sub) => `<div class="frow"><label>${label}${sub ? `<small>${sub}</small>` : ''}</label><div class="ctl">${inner}</div></div>`;
      let h = '';
      if (tab === 'paint') {
        h += `<div class="section-title">Plastics & graphics</div>`;
        h += row('Plastics', sw('plastics', PALETTE));
        h += row('Graphics', `<div class="seg">${['race', 'stripes', 'blocks', 'flames', 'none'].map((g) => `<button data-look="graphics" data-val="${g}" class="${L.graphics === g ? 'on' : ''}">${g.toUpperCase()}</button>`).join('')}</div>`);
        h += row('Graphics colour', sw('graphicsColor', PALETTE));
        h += `<div class="section-title">Chassis</div>`;
        h += row('Frame', sw('frame', ['#9aa0a8', '#c9a03a', '#1a1a1a', '#e5262b', '#1d6cff', '#ff7a00', '#22b14c', '#f2f2f2']));
        h += row('Seat', sw('seat', DARKS));
        h += row('Rims', sw('rims', ['#202226', '#c9a03a', '#9aa0a8', '#1d6cff', '#e5262b', '#ff7a00', '#22b14c', '#f2f2f2']));
        h += `<div class="section-title">Number plates</div>`;
        h += row('Plate background', sw('plateBg', ['#ffffff', '#ffd23f', '#1a1a1a', '#e5262b', '#1d6cff', '#22b14c', '#ff7a00']));
        h += row('Number colour', sw('plateNum', ['#111111', '#ffffff', '#e5262b', '#1d6cff', '#ff7a00', '#ffd23f']));
        h += row('Race number', `<button class="sbtn" data-numstep="-1">−</button><input class="num" type="text" maxlength="3" data-num value="${esc(L.number)}"><button class="sbtn" data-numstep="1">+</button>`);
        h += `<div class="frow"><label>Factory paint<small>Back to the stock colours of the ${esc(b.name)}</small></label><div class="ctl"><button class="sbtn danger" data-cmd="reset-paint">RESET PAINT</button></div></div>`;
      } else if (tab === 'rider') {
        h += `<div class="section-title">Riding gear</div>`;
        h += row('Jersey', sw('jersey', PALETTE));
        h += row('Jersey accent', sw('jersey2', PALETTE));
        h += row('Pants', sw('pants', [...DARKS.slice(0, 6), '#f2f2f2', '#ff7a00', '#1d6cff', '#e5262b']));
        h += row('Gloves', sw('gloves', PALETTE));
        h += row('Boots', sw('boots', ['#e8e8e8', '#1a1a1a', '#ff7a00', '#e5262b', '#1d6cff', '#ffd23f']));
        h += `<div class="section-title">Helmet</div>`;
        h += row('Helmet', sw('helmet', PALETTE));
        h += row('Helmet accent', sw('helmetAccent', PALETTE));
        h += row('Goggle lens', sw('goggle', ['#2b6cff', '#ff7a00', '#c9a03a', '#1a1a1a', '#e5262b', '#22b14c', '#e8e8e8']));
      } else {
        const st = MX.setupFor(this.G, b.id);
        const r = (k, min, max, step, label, sub) => `<div class="frow"><label>${label}<small>${sub}</small></label><div class="ctl"><input type="range" data-setup="${k}" min="${min}" max="${max}" step="${step}" value="${st[k]}"><span class="val">${this._fmtSetup(k, st[k])}</span></div></div>`;
        h += `<div class="section-title">Suspension</div>`;
        h += r('forkSpring', 0.8, 1.25, 0.01, 'Front fork spring', 'Stiffer holds up under braking & big landings, softer soaks small bumps');
        h += r('shockSpring', 0.8, 1.25, 0.01, 'Rear shock spring', 'Stiffer for big jumps, softer for traction');
        h += r('compression', 0.7, 1.5, 0.01, 'Compression damping', 'How hard it resists bottoming');
        h += r('rebound', 0.7, 1.5, 0.01, 'Rebound damping', 'Slower rebound stops the bike kicking off lips');
        h += `<div class="section-title">Drivetrain & chassis</div>`;
        h += r('sprocket', 46, 54, 1, 'Rear sprocket', 'More teeth: punchier, lower top speed');
        h += r('steering', 0.75, 1.3, 0.01, 'Steering response', 'How quickly the bike drops into a lean');
        h += `<div class="frow"><label>Reset<small>Back to the stock setup for the ${esc(b.name)}</small></label><div class="ctl"><button class="sbtn danger" data-cmd="reset-setup">RESET SETUP</button></div></div>`;
      }
      $('garage-body').innerHTML = h;
    }

    // ------------------------------------------------------------ settings
    render_settings() {
      const tab = this.tabs.settings;
      document.querySelectorAll('[data-tabs="settings"] .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
      const S = this.S;
      let h = '';
      if (tab === 'graphics') {
        h += this.seg('graphics.quality', [['low', 'LOW'], ['medium', 'MEDIUM'], ['high', 'HIGH'], ['ultra', 'ULTRA']], 'Graphics quality', 'Trees, shadow detail, terrain resolution (applies on the next track load)');
        h += this.range('graphics.resScale', 0.5, 1.25, 0.05, 'Resolution scale', 'Lower for more frames per second');
        h += this.toggle('graphics.dynamicRes', 'Dynamic resolution', 'While riding, lowers the resolution a little when the frame rate drops below 60 and raises it again when there is headroom');
        h += this.toggle('graphics.shadows', 'Shadows');
        h += this.range('graphics.fov', 55, 95, 1, 'Field of view');
        h += this.toggle('graphics.showFps', 'Show FPS counter');
        h += `<div class="frow"><label>Fullscreen</label><div class="ctl"><button class="sbtn wide" data-cmd="fullscreen">${document.fullscreenElement ? 'EXIT FULLSCREEN' : 'GO FULLSCREEN'}</button></div></div>`;
      } else if (tab === 'audio') {
        h += this.range('audio.master', 0, 1, 0.01, 'Master volume');
        h += this.range('audio.engine', 0, 1, 0.01, 'Engine volume');
        h += this.range('audio.effects', 0, 1, 0.01, 'Effects volume', 'Tyres, wind, landings, shifts');
        h += this.range('audio.music', 0, 1, 0.01, 'Music volume');
        h += this.toggle('audio.gameMusic', 'Music while riding');
      } else if (tab === 'gameplay') {
        h += `<div class="section-title">Riding</div>`;
        h += this.toggle('gameplay.autoClutch', 'Automatic clutch', 'Slips the clutch at low revs so you never stall. Off: you can stall, pull the clutch to restart');
        h += this.toggle('gameplay.autoShift', 'Automatic gearbox');
        h += this.toggle('gameplay.tractionControl', 'Traction control', 'Like the factory TC on modern MX bikes: trims power when the rear spins up');
        h += this.seg('gameplay.riderAssist', [[0, 'OFF'], [1, 'STANDARD'], [2, 'HIGH']], 'Rider instinct', 'Weight shifts and throttle/brake reflexes that stop loop-outs & endos and straighten the bike in the air. Off is pure simulation');
        h += this.seg('gameplay.units', [['kmh', 'KM/H'], ['mph', 'MPH']], 'Speed units');
        h += this.toggle('gameplay.showInputs', 'Show input bars', 'Throttle, brakes, clutch, lean and body position');
        h += `<div class="section-title">Camera</div>`;
        h += this.seg('gameplay.defaultCamera', [['chase', 'CHASE'], ['helmet', 'HELMET'], ['side', 'SIDE'], ['free', 'FREE']], 'Starting camera');
        h += this.range('gameplay.cameraDistance', 0.6, 2.0, 0.05, 'Camera distance');
        h += this.range('gameplay.cameraHeight', 0.5, 2.0, 0.05, 'Camera height');
        h += this.range('gameplay.cameraSensitivity', 0.2, 3, 0.05, 'Mouse camera sensitivity');
        h += this.toggle('gameplay.invertX', 'Invert camera left/right (mouse)');
        h += this.toggle('gameplay.invertY', 'Invert camera up/down (mouse)');
      } else if (tab === 'keyboard') {
        h += `<div class="section-title">Keyboard bindings</div><div style="color:var(--muted);font-size:13px;margin-bottom:8px">Click a key to change it. Each action can have two keys.</div>`;
        for (const a of MX.INPUT_ACTIONS.filter((a) => a.kb)) {
          const k = S.keyboard.bindings[a.id] || [];
          h += `<div class="frow"><label>${a.label}</label><div class="ctl"><button class="sbtn key" data-key="${a.id}" data-slot="0">${esc(MX.keyLabel(k[0]))}</button><button class="sbtn key" data-key="${a.id}" data-slot="1">${esc(k[1] ? MX.keyLabel(k[1]) : '+')}</button></div></div>`;
        }
        h += `<div class="frow"><label>Reset</label><div class="ctl"><button class="sbtn danger" data-cmd="reset-keys">RESET KEYBOARD</button></div></div>`;
      } else if (tab === 'controller') {
        const pad = this.game.input.padInfo();
        const kind = pad ? pad.kind : 'xbox';
        h += `<div class="section-title">Controller</div>`;
        h += `<div class="pad-tester"><div class="pad-name" id="pad-name">${pad ? esc(pad.id) + `<small>${kind === 'ps' ? 'PlayStation layout' : kind === 'xbox' ? 'Xbox layout' : 'Generic layout'} · ${pad.mapping === 'standard' ? 'standard mapping' : 'non-standard mapping'}</small>` : 'No controller detected<small>Connect one and press any button</small>'}</div>
          <div class="stick" id="t-ls"><span class="dz"></span><i></i></div><div class="stick" id="t-rs"><span class="dz"></span><i></i></div>
          <div class="tbar" id="t-lt"><i></i></div><div class="tbar" id="t-rt"><i></i></div><div class="pad-buttons" id="t-btn"></div></div>`;
        h += `<div class="section-title">Bindings</div>`;
        for (const a of MX.INPUT_ACTIONS.filter((a) => a.pad)) {
          h += `<div class="frow"><label>${a.label}</label><div class="ctl"><button class="sbtn key" data-padbind="${a.id}">${esc(this.game.input.bindingLabel(S.controller.bindings[a.id], kind))}</button></div></div>`;
        }
        h += `<div class="section-title">Feel</div>`;
        h += this.range('controller.deadzone', 0.0, 0.35, 0.01, 'Stick dead zone', 'Raise it if the bike leans with the stick released');
        h += this.range('controller.triggerDeadzone', 0.0, 0.3, 0.01, 'Trigger dead zone');
        h += this.range('controller.steerSensitivity', 0.5, 2, 0.05, 'Steering sensitivity', 'Also scales keyboard lean speed');
        h += this.range('controller.throttleSensitivity', 0.6, 2, 0.05, 'Throttle sensitivity');
        h += this.range('controller.brakeSensitivity', 0.6, 2, 0.05, 'Brake sensitivity');
        h += this.range('controller.cameraSensitivity', 0.2, 3, 0.05, 'Camera sensitivity');
        h += this.toggle('controller.invertX', 'Invert camera left/right');
        h += this.toggle('controller.invertY', 'Invert camera up/down');
        h += this.toggle('controller.vibration', 'Vibration');
        h += `<div class="frow"><label>Reset</label><div class="ctl"><button class="sbtn danger" data-cmd="reset-pad">RESET CONTROLLER SETTINGS</button></div></div>`;
      }
      $('settings-body').innerHTML = h;
    }

    // live controller tester (called each frame while visible)
    tickTester() {
      if (this.current !== 'settings' || this.tabs.settings !== 'controller') return;
      const raw = this.game.input.raw;
      const ls = $('t-ls'), rs = $('t-rs');
      if (!ls) return;
      const B = this.S.controller.bindings;
      const ax = (b) => (raw && b ? (b.t === 'a' ? raw.axes[b.i] || 0 : raw.buttons[b.i] || 0) : 0);
      const place = (el, x, y) => { const i = el.querySelector('i'); i.style.left = (50 + x * 42) + '%'; i.style.top = (50 + y * 42) + '%'; const dz = el.querySelector('.dz'); const d = this.S.controller.deadzone * 74; dz.style.width = dz.style.height = d + 'px'; dz.style.marginLeft = dz.style.marginTop = (-d / 2) + 'px'; };
      place(ls, raw ? raw.axes[B.lean.i] || 0 : 0, raw ? (raw.axes[B.rider.i] || 0) : 0);
      place(rs, raw ? raw.axes[B.camX.i] || 0 : 0, raw ? raw.axes[B.camY.i] || 0 : 0);
      const trig = (b) => { if (!raw || !b) return 0; if (b.t === 'b') return raw.buttons[b.i] || 0; const v = raw.axes[b.i] || 0; return b.rest === -1 ? (v + 1) / 2 : Math.max(0, v); };
      $('t-lt').querySelector('i').style.height = Math.round(trig(B.front) * 100) + '%';
      $('t-rt').querySelector('i').style.height = Math.round(trig(B.throttle) * 100) + '%';
      const kind = (this.game.input.padInfo() || {}).kind;
      const btns = raw ? raw.buttons.map((v, i) => `<span class="${v > 0.5 ? 'on' : ''}">${esc(this.game.input.buttonLabel(i, kind))}</span>`).join('') : '';
      const bt = $('t-btn');
      if (bt.innerHTML !== btns) bt.innerHTML = btns;
      void ax;
    }

    _captureKey(action, slot) {
      this.capturing = true;
      $('capture-title').textContent = 'Press a key for "' + (MX.INPUT_ACTIONS.find((a) => a.id === action) || {}).label + '"';
      $('capture-sub').textContent = 'Esc to cancel · Backspace clears the second key';
      $('capture').classList.remove('hidden');
      this.game.input.startCapture('key', (code) => {
        $('capture').classList.add('hidden');
        setTimeout(() => { this.capturing = false; }, 50);
        if (!code) return;
        const B = this.S.keyboard.bindings;
        const list = (B[action] || []).slice();
        if (code === 'Backspace' && slot === 1) list.splice(1, 1);
        else {
          // remove the key from other actions to avoid conflicts
          for (const id of Object.keys(B)) if (id !== action) B[id] = (B[id] || []).filter((c) => c !== code);
          list[slot] = code;
        }
        B[action] = list.filter(Boolean);
        MX.saveSettings(this.S);
        this.game.audio.ui('select');
        this.render_settings();
        const el = document.querySelector(`[data-key="${action}"][data-slot="${slot}"]`); if (el) this._setFocus(el);
      });
    }

    _capturePad(action) {
      const a = MX.INPUT_ACTIONS.find((x) => x.id === action);
      this.capturing = true;
      $('capture-title').textContent = a.pad === 'axis' ? `Move the stick for "${a.label}"` : `Press a button or trigger for "${a.label}"`;
      $('capture-sub').textContent = a.pad === 'axis' ? 'Push it right (lean/camera) or forward (rider). Esc cancels' : 'Esc cancels';
      $('capture').classList.remove('hidden');
      const done = () => { $('capture').classList.add('hidden'); setTimeout(() => { this.capturing = false; }, 300); window.removeEventListener('keydown', onKey, true); };
      const onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); this.game.input.cancelCapture(); done(); } };
      window.addEventListener('keydown', onKey, true);
      this.game.input.startCapture('pad', (b) => {
        done();
        if (!b) return;
        let bind = b;
        if (a.pad === 'axis') {
          if (b.t !== 'a') { this.game.audio.ui('error'); MX.toast('That action needs a stick axis', 'bad'); return; }
          bind = { t: 'a', i: b.i, inv: action === 'rider' ? b.dir > 0 : b.dir < 0 };
        } else if (b.t === 'a' && b.rest !== -1) bind = { t: 'a', i: b.i, s: b.dir };
        this.S.controller.bindings[action] = bind;
        this.S.controller.custom = true;
        MX.saveSettings(this.S);
        this.game.audio.ui('select');
        this.render_settings();
        const el = document.querySelector(`[data-padbind="${action}"]`); if (el) this._setFocus(el);
      });
    }

    _cmd(cmd, t) {
      const g = this.game;
      if (cmd === 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen && document.exitFullscreen();
        else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => MX.toast('Fullscreen was blocked by the browser', 'bad'));
        setTimeout(() => this.render_settings(), 300);
      } else if (cmd === 'reset-keys') {
        this.S.keyboard.bindings = MX.defaultKeys(); MX.saveSettings(this.S); this.render_settings(); MX.toast('Keyboard reset to defaults');
      } else if (cmd === 'reset-pad') {
        const d = MX.defaultSettings().controller;
        Object.assign(this.S.controller, d);
        const p = g.input.padInfo();
        if (p && p.mapping !== 'standard') g.input._padConnected({ id: p.id, index: p.index, mapping: p.mapping });
        MX.saveSettings(this.S); this.render_settings(); MX.toast('Controller settings reset');
      } else if (cmd === 'reset-paint') {
        delete this.G.paint[this.G.bike]; MX.saveGarage(this.G); g.refreshLook(); this.render_garage(); MX.toast('Factory paint restored');
      } else if (cmd === 'reset-setup') {
        delete this.G.setups[this.G.bike]; MX.saveGarage(this.G); g.refreshSetup(); this.render_garage(); MX.toast('Setup reset');
      }
      g.audio.ui('select');
      void t;
    }

    // ------------------------------------------------------------ controls
    render_controls() {
      const S = this.S, inp = this.game.input;
      const pad = inp.padInfo();
      const kind = pad ? pad.kind : 'xbox';
      const K = (id) => (S.keyboard.bindings[id] || []).map((c) => `<span class="kbd">${esc(MX.keyLabel(c))}</span>`).join(' ');
      const P = (id) => `<span class="kbd pad">${esc(inp.bindingLabel(S.controller.bindings[id], kind))}</span>`;
      const rows = [
        ['Accelerate', K('throttle'), P('throttle')], ['Front brake', K('front'), P('front')], ['Rear brake', K('rear'), P('rear')],
        ['Clutch', K('clutch'), P('clutch')], ['Lean left / right', K('leanLeft') + ' ' + K('leanRight'), `<span class="kbd pad">Left stick ↔</span>`],
        ['Rider forward / back', K('riderFwd') + ' ' + K('riderBack'), `<span class="kbd pad">Left stick ↕</span>`],
        ['Shift up', K('shiftUp'), P('shiftUp')], ['Shift down', K('shiftDown'), P('shiftDown')],
        ['Change camera', K('camera'), P('camera')], ['Reset bike', K('reset'), P('reset')], ['Pause', K('pause'), P('pause')],
        ['Look around', K('lookLeft') + ' ' + K('lookRight') + ' / mouse drag', `<span class="kbd pad">Right stick</span>`],
      ];
      let h = `<div class="ctable"><h3>Keyboard & controller</h3>${rows.map((r) => `<div class="crow"><span>${r[0]}</span><span>${r[1]}</span><span>${r[2]}</span></div>`).join('')}
        <div style="color:var(--muted);font-size:13px;margin-top:10px">${pad ? 'Connected: ' + esc(pad.id) : 'No controller connected: plug one in and press a button.'} Remap everything in Settings.</div></div>`;
      h += `<div class="ctable"><h3>Riding technique</h3><ul class="tips">
        <li><b>Lean, don't steer.</b> Lean input tells the rider how far to lay the bike over; he counter-steers to get there. Ask for more lean than the dirt can hold and you lowside. Berms let you lean much further.</li>
        <li><b>Body position matters.</b> Forward (↑) loads the front for turning and kills wheelies; back (↓) for acceleration, whoops and landings. In the air, forward drops the nose and back lifts it.</li>
        <li><b>Throttle and rear brake work in the air.</b> Gas spins the rear wheel up and lifts the nose; a dab of rear brake brings it down.</li>
        <li><b>Whip:</b> hold a lean as the bike leaves the lip and in the air: the rear kicks out and the bike lays flat. Straighten up before you land or you'll go down.</li>
        <li><b>Scrub:</b> lean hard into the face just before the lip: the bike lays over, the suspension's kick goes sideways and you fly lower and faster.</li>
        <li><b>Clutch:</b> pull it, rev, dump it to launch or to pop the front over an obstacle. With auto clutch off you can stall: pull the clutch to restart.</li>
        <li><b>Land on the down-slope.</b> Casing a face or overshooting to flat bottoms the suspension and can throw you off.</li></ul></div>`;
      $('controls-body').innerHTML = h;
    }

    // ------------------------------------------------------------ pause
    render_pause() {
      const g = this.game;
      const b = MX.bikeById(this.G.bike), t = MX.trackById(this.G.track);
      $('pause-info').textContent = `${t.name} · ${b.name} · Lap ${g.lap.lapCount + 1} · Best ${MX.fmtLap(g.lap.best)}`;
    }

    // ------------------------------------------------------------ focus / navigation
    _focusables() {
      const scr = this.current && $(this.current);
      if (!scr) return [];
      return Array.from(scr.querySelectorAll('button:not([disabled]), input[type=range], input[type=text], .tcard')).filter((el) => el.offsetParent !== null || el.getClientRects().length);
    }
    _setFocus(el, fromMouse) {
      if (this.focusEl === el) return;
      if (this.focusEl) { this.focusEl.classList.remove('focus'); const r = this.focusEl.closest('.frow'); if (r) r.classList.remove('focus-row'); }
      this.focusEl = el;
      if (el) {
        el.classList.add('focus');
        const r = el.closest('.frow'); if (r) r.classList.add('focus-row');
        if (!fromMouse) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        this.game.audio.ui('hover');
        if (this.current === 'bikes' && el.dataset.bike && !fromMouse) { /* preview on focus */ this._bikeInfo(MX.bikeById(el.dataset.bike)); }
      }
    }
    _focusFirst(keepTab) {
      const list = this._focusables();
      let el = null;
      if (this.current === 'bikes') el = list.find((e) => e.classList.contains('bcard') && e.classList.contains('on'));
      if (this.current === 'tracks') el = list.find((e) => e.classList.contains('tcard') && e.classList.contains('on'));
      if (keepTab) el = list.find((e) => e.classList.contains('tab') && e.classList.contains('on'));
      if (!el) el = list.find((e) => !e.classList.contains('back') && !e.classList.contains('tab')) || list[0];
      if (this.focusEl) this.focusEl.classList.remove('focus');
      this.focusEl = null;
      if (el && this.game.input.lastDevice === 'pad') this._setFocus(el);
      else this.focusEl = el || null, el && el.classList.add('focus');
    }

    handleNav(events) {
      if (!this.current || this.capturing) return;
      for (const ev of events) {
        if (ev.type === 'back') { this.back(); continue; }
        if (ev.type === 'start') { if (this.current === 'menu') this.game.action('play'); else if (this.current === 'pause') this.game.resume(); continue; }
        if (ev.type === 'tabPrev' || ev.type === 'tabNext') { this._switchTab(ev.type === 'tabNext' ? 1 : -1); continue; }
        const el = this.focusEl;
        if (ev.type === 'confirm') {
          if (el && el.tagName !== 'INPUT') { el.click(); }
          continue;
        }
        if (el && el.type === 'range' && (ev.type === 'left' || ev.type === 'right')) {
          const step = parseFloat(el.step) || 0.01;
          const v = clamp(parseFloat(el.value) + (ev.type === 'right' ? step : -step) * (ev.repeat ? 2 : 1), parseFloat(el.min), parseFloat(el.max));
          el.value = v; this._input(el, true);
          continue;
        }
        if (ev.device === 'kb' && el && el.type === 'text') continue;
        this._move(ev.type);
      }
    }
    _switchTab(d) {
      const group = this.current === 'garage' ? 'garage' : this.current === 'settings' ? 'settings' : null;
      if (!group) return;
      const tabs = Array.from(document.querySelectorAll(`[data-tabs="${group}"] .tab`));
      let i = tabs.findIndex((t) => t.dataset.tab === this.tabs[group]);
      i = (i + d + tabs.length) % tabs.length;
      this.tabs[group] = tabs[i].dataset.tab;
      this.game.audio.ui('hover');
      this['render_' + group]();
      this._focusFirst(true);
    }
    _move(dir) {
      const list = this._focusables();
      if (!list.length) return;
      const cur = this.focusEl && list.includes(this.focusEl) ? this.focusEl : null;
      if (!cur) { this._setFocus(list[0]); return; }
      const r0 = cur.getBoundingClientRect();
      const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
      const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
      if (!D) return;
      let best = null, bestScore = Infinity;
      for (const el of list) {
        if (el === cur) continue;
        const r = el.getBoundingClientRect();
        const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const dx = c.x - c0.x, dy = c.y - c0.y;
        const along = dx * D[0] + dy * D[1];
        if (along <= 4) continue;
        const across = Math.abs(dx * D[1] - dy * D[0]);
        // prefer overlapping rows/columns
        const overlap = D[0] === 0 ? (r.right > r0.left && r.left < r0.right) : (r.bottom > r0.top && r.top < r0.bottom);
        const score = along + across * (overlap ? 0.5 : 2.5);
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best) this._setFocus(best);
    }
  }

  MX.UI = UI;
});
