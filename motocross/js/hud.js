/* =====================================================================
   ROOST MX - in-game HUD: tachometer, gear, speed, lap timing, inputs,
   minimap, crash/air messages and toasts.
   ===================================================================== */
MX.module('hud', function (THREE, MX) {
  'use strict';
  const { clamp } = MX;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------- toasts
  MX.toast = function (text, kind, ms) {
    const box = $('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms || 2600);
  };

  const A0 = 135, A1 = 405, CX = 110, CY = 110, R = 92;
  const pt = (a, r) => { const t = (a * Math.PI) / 180; return [CX + Math.cos(t) * r, CY + Math.sin(t) * r]; };
  function arc(a0, a1, r) {
    const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  class HUD {
    constructor() {
      this.el = {
        gear: $('hud-gear'), speed: $('hud-speed'), unit: $('hud-unit'), rpm: $('hud-rpm'), shift: $('shift-light'),
        time: $('hud-time'), last: $('hud-last'), best: $('hud-best'), lapn: $('hud-lapn'), track: $('hud-track'), cp: $('hud-cp'),
        thr: $('in-thr'), front: $('in-front'), rear: $('in-rear'), clutch: $('in-clutch'), lean: $('in-lean'), rider: $('in-rider'),
        inputs: $('hud-inputs'), assist: $('assist-tags'), fps: $('hud-fps'), air: $('hud-air'), crash: $('hud-crash'),
        crashReason: $('crash-reason'), crashHint: $('crash-hint'), map: $('hud-map'),
      };
      const svg = $('tacho');
      this.fill = svg.querySelector('.tacho-fill');
      svg.querySelector('.tacho-bg').setAttribute('d', arc(A0, A1, R));
      this.redPath = svg.querySelector('.tacho-red');
      this.ticks = svg.querySelector('.tacho-ticks');
      this.last = {};
      this.airT = 0;
      this.cp = document.createElement('i');
      this.el.cp.appendChild(this.cp);
    }

    setBike(spec) {
      this.spec = spec;
      const lim = spec.engine.limit;
      this.maxRpm = Math.ceil(lim / 1000) * 1000 + 1000;
      const ang = (rpm) => A0 + (A1 - A0) * clamp(rpm / this.maxRpm, 0, 1);
      this.ang = ang;
      this.redPath.setAttribute('d', arc(ang(lim * 0.93), A1, R));
      let h = '';
      for (let k = 0; k <= this.maxRpm; k += 1000) {
        const a = ang(k);
        const [x0, y0] = pt(a, R - 12), [x1, y1] = pt(a, R - 20), [tx, ty] = pt(a, R - 32);
        h += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`;
        if ((k / 1000) % 2 === 0 || this.maxRpm <= 10000) h += `<text x="${tx}" y="${ty + 4}">${k / 1000}</text>`;
      }
      this.ticks.innerHTML = h;
    }

    setTrack(track, records, bikeId) {
      this.track = track;
      this.el.track.textContent = track.def.short;
      this._drawMapBase(track);
    }

    _drawMapBase(track) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 200;
      const g = cv.getContext('2d');
      const b = track.bbox;
      const pad = 14;
      const sx = (200 - 2 * pad) / Math.max(b.maxx - b.minx, b.maxz - b.minz);
      const ox = 100 - ((b.minx + b.maxx) / 2) * sx, oz = 100 - ((b.minz + b.maxz) / 2) * sx;
      // map: x right, z down when viewed from above (+Y): mirror x so it matches the camera view
      this.mapT = (x, z) => [200 - (x * sx + ox), z * sx + oz];
      g.lineJoin = 'round'; g.lineCap = 'round';
      const path = () => { g.beginPath(); for (let i = 0; i <= track.n; i += 4) { const k = i % track.n; const [x, y] = this.mapT(track.px[k], track.pz[k]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.closePath(); };
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 9; path(); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 4.5; path(); g.stroke();
      // jumps
      g.fillStyle = '#ff7a00';
      for (const f of track.features) { const p = track.pointAt((f.s0 + f.s1) / 2); const [x, y] = this.mapT(p.x, p.z); g.fillRect(x - 2, y - 2, 4, 4); }
      // finish line
      const fp = track.pointAt(track.finishS); const [fx, fy] = this.mapT(fp.x, fp.z);
      g.fillStyle = '#fff'; g.fillRect(fx - 4, fy - 4, 8, 8); g.fillStyle = '#111'; g.fillRect(fx - 4, fy - 4, 4, 4); g.fillRect(fx, fy, 4, 4);
      this.mapBase = cv;
    }

    show(on) { document.getElementById('hud').style.visibility = on ? 'visible' : 'hidden'; }

    update(dt, game) {
      const p = game.phys, e = this.el, S = game.settings;
      const set = (k, v, el, fn) => { if (this.last[k] !== v) { this.last[k] = v; fn ? fn(el, v) : (el.textContent = v); } };
      const mph = S.gameplay.units === 'mph';
      const spd = Math.round(Math.max(0, p.forwardSpeed) * (mph ? 2.23694 : 3.6));
      set('spd', spd, e.speed);
      set('unit', mph ? 'MPH' : 'KM/H', e.unit);
      const gear = p.engine.stalled ? 'S' : p.gear === 0 ? 'N' : String(p.gear);
      set('gear', gear, e.gear, (el, v) => { el.textContent = v; el.classList.toggle('n', v === 'N'); });
      const rpm = p.rpm;
      set('rpm', Math.round(rpm / 50) * 50, e.rpm, (el, v) => { el.textContent = v + ' RPM'; });
      const a = this.ang ? this.ang(rpm) : A0;
      const aKey = Math.round(a * 2) / 2;
      set('arc', aKey, this.fill, (el, v) => el.setAttribute('d', v > A0 + 0.5 ? arc(A0, v, R) : ''));
      const lim = this.spec.engine.limit;
      const shiftOn = rpm > lim * 0.9 && p.gear > 0;
      set('shift', (rpm > lim * 0.985 ? 2 : shiftOn ? 1 : 0), e.shift, (el, v) => { el.classList.toggle('on', v > 0); el.classList.toggle('blink', v === 2); });
      // lap timing
      const L = game.lap;
      set('time', L.running ? MX.fmtLap(L.time) : (L.started ? MX.fmtLap(L.time) : '0:00.000'), e.time);
      set('lastl', MX.fmtLap(L.lastLap), e.last);
      set('best', MX.fmtLap(L.best), e.best);
      set('lapn', L.lapCount > 0 || L.running ? String(L.lapCount + 1) : '–', e.lapn);
      const cpFrac = L.running ? L.nextCp / Math.max(1, L.cps.length) : 0;
      set('cp', Math.round(cpFrac * 100), this.cp, (el, v) => { el.style.width = v + '%'; });
      // inputs
      const showIn = S.gameplay.showInputs;
      set('inv', showIn, e.inputs, (el, v) => { el.style.display = v ? 'flex' : 'none'; });
      if (showIn) {
        const inp = p.input;
        set('ithr', Math.round(p.engine.thrEff * 100), e.thr, (el, v) => (el.style.height = v + '%'));
        set('ifr', Math.round((p.frontBrakeEff != null ? p.frontBrakeEff : inp.front) * 100), e.front, (el, v) => (el.style.height = v + '%'));
        set('ire', Math.round(inp.rear * 100), e.rear, (el, v) => (el.style.height = v + '%'));
        set('icl', Math.round(inp.clutch * 100), e.clutch, (el, v) => (el.style.height = v + '%'));
        set('ilean', Math.round(inp.lean * 50), e.lean, (el, v) => (el.style.left = (50 + v) + '%'));
        set('irider', Math.round(-inp.rider * 45), e.rider, (el, v) => (el.style.top = (50 + v) + '%'));
        const tags = (S.gameplay.tractionControl ? (p.tcCut > 0.05 ? 'T' : 't') : '') + (S.gameplay.autoClutch ? 'C' : '') + (S.gameplay.autoShift ? 'A' : '');
        set('tags', tags, e.assist, (el) => {
          el.innerHTML = (S.gameplay.tractionControl ? `<span class="${p.tcCut > 0.05 ? 'on' : ''}">TC</span>` : '') + (S.gameplay.autoClutch ? '<span>AUTO CLUTCH</span>' : '') + (S.gameplay.autoShift ? '<span>AUTO SHIFT</span>' : '');
        });
      }
      // air time
      if (this.airT > 0) { this.airT -= dt; if (this.airT <= 0) e.air.classList.remove('show'); }
      // crash
      const crashed = p.crashed;
      set('crash', crashed, e.crash, (el, v) => el.classList.toggle('show', !!v));
      if (crashed) {
        set('creason', p.crash.reason.toUpperCase(), e.crashReason);
        const left = Math.max(0, Math.ceil(game.autoResetIn));
        const btn = game.input.promptKind() === 'kb' ? MX.keyLabel((S.keyboard.bindings.reset || [])[0]) : game.input.bindingLabel(S.controller.bindings.reset, game.input.promptKind());
        set('chint', `Press ${btn} to reset · auto in ${left}`, e.crashHint);
      }
      // fps
      if (S.graphics.showFps) {
        this.fpsAcc = (this.fpsAcc || 0) + dt; this.fpsN = (this.fpsN || 0) + 1;
        if (this.fpsAcc > 0.5) { e.fps.textContent = Math.round(this.fpsN / this.fpsAcc) + ' FPS · ' + game.physSteps + ' steps'; this.fpsAcc = 0; this.fpsN = 0; }
      } else if (e.fps.textContent) e.fps.textContent = '';
      // minimap
      this._drawMap(game);
    }

    _drawMap(game) {
      const cv = this.el.map;
      if (!this.mapBase || !cv) return;
      this.mapTick = (this.mapTick || 0) + 1;
      if (this.mapTick % 3) return;
      const g = cv.getContext('2d');
      g.clearRect(0, 0, 200, 200);
      g.drawImage(this.mapBase, 0, 0);
      const p = game.phys.crashed ? game.phys.crash.rider.pos : game.phys.pos;
      const [x, y] = this.mapT(p.x, p.z);
      g.fillStyle = '#ff7a00'; g.strokeStyle = '#000'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill(); g.stroke();
    }

    air(t, h) {
      if (t < 0.9) return;
      this.el.air.textContent = `AIR ${t.toFixed(1)}s`;
      this.el.air.classList.add('show');
      this.airT = 1.4;
    }
  }

  MX.HUD = HUD;
});
