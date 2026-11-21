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

  const _mp = [0, 0];

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
      // the rev arc is the whole arc revealed by a dash offset: no path rebuilt per frame
      this.fill.setAttribute('d', arc(A0, A1, R));
      this.arcLen = R * (A1 - A0) * Math.PI / 180;
      this.fill.style.strokeDasharray = this.arcLen + ' ' + this.arcLen;
      this.fill.style.strokeDashoffset = this.arcLen;
      this.redPath = svg.querySelector('.tacho-red');
      this.ticks = svg.querySelector('.tacho-ticks');
      this.last = {};
      this.airT = 0;
      this.cp = document.createElement('i');
      this.el.cp.appendChild(this.cp);
      // minimap: the track is drawn once, the bike is a dot moved with a transform
      const wrap = document.createElement('div');
      wrap.className = 'hud-mapdot';
      this.dot = document.createElement('i');
      wrap.appendChild(this.dot);
      this.el.map.after(wrap);
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
      this.mapT = (x, z, out) => { out = out || []; out[0] = 200 - (x * sx + ox); out[1] = z * sx + oz; return out; };
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
      const vis = this.el.map.getContext('2d');
      vis.clearRect(0, 0, 200, 200);
      vis.drawImage(cv, 0, 0);
      this.last.mx = this.last.my = null;
    }

    show(on) { document.getElementById('hud').style.visibility = on ? 'visible' : 'hidden'; }

    // Only touches the DOM when a shown value changes; bars and markers move
    // with transforms (no layout), the rev arc with a dash offset.
    update(dt, game) {
      const p = game.phys, e = this.el, S = game.settings, last = this.last;
      const mph = S.gameplay.units === 'mph';
      const spd = Math.round(Math.max(0, p.forwardSpeed) * (mph ? 2.23694 : 3.6));
      if (last.spd !== spd) { last.spd = spd; e.speed.textContent = spd; }
      const unit = mph ? 'MPH' : 'KM/H';
      if (last.unit !== unit) { last.unit = unit; e.unit.textContent = unit; }
      const gear = p.engine.stalled ? 'S' : p.gear === 0 ? 'N' : String(p.gear);
      if (last.gear !== gear) { last.gear = gear; e.gear.textContent = gear; e.gear.classList.toggle('n', gear === 'N'); }
      const rpm = p.rpm, rpmQ = Math.round(rpm / 50) * 50;
      if (last.rpm !== rpmQ) { last.rpm = rpmQ; e.rpm.textContent = rpmQ + ' RPM'; }
      const frac = this.maxRpm ? clamp(rpm / this.maxRpm, 0, 1) : 0;
      const off = Math.round((1 - frac) * this.arcLen * 2) / 2;
      if (last.arc !== off) { last.arc = off; this.fill.style.strokeDashoffset = off; }
      const lim = this.spec.engine.limit;
      const shift = rpm > lim * 0.985 ? 2 : rpm > lim * 0.9 && p.gear > 0 ? 1 : 0;
      if (last.shift !== shift) { last.shift = shift; e.shift.classList.toggle('on', shift > 0); e.shift.classList.toggle('blink', shift === 2); }
      // lap timing
      const L = game.lap;
      if (L.running || L.started) {
        const ms = Math.floor(L.time * 1000);
        if (last.timeMs !== ms) { last.timeMs = ms; e.time.textContent = MX.fmtLap(L.time); }
      } else if (last.timeMs !== -1) { last.timeMs = -1; e.time.textContent = '0:00.000'; }
      if (last.lastLap !== L.lastLap) { last.lastLap = L.lastLap; e.last.textContent = MX.fmtLap(L.lastLap); }
      if (last.best !== L.best) { last.best = L.best; e.best.textContent = MX.fmtLap(L.best); }
      const lapn = L.lapCount > 0 || L.running ? L.lapCount + 1 : 0;
      if (last.lapn !== lapn) { last.lapn = lapn; e.lapn.textContent = lapn ? String(lapn) : '–'; }
      const cp = L.running ? Math.round(L.nextCp / Math.max(1, L.cps.length) * 100) / 100 : 0;
      if (last.cp !== cp) { last.cp = cp; this.cp.style.transform = 'scaleX(' + cp + ')'; }
      // inputs
      const showIn = S.gameplay.showInputs;
      if (last.inv !== showIn) { last.inv = showIn; e.inputs.style.display = showIn ? 'flex' : 'none'; }
      if (showIn) {
        const inp = p.input;
        const bar = (k, v, el) => { if (last[k] !== v) { last[k] = v; el.style.transform = 'scaleY(' + v + ')'; } };
        bar('ithr', Math.round(p.engine.thrEff * 100) / 100, e.thr);
        bar('ifr', Math.round((p.frontBrakeEff != null ? p.frontBrakeEff : inp.front) * 100) / 100, e.front);
        bar('ire', Math.round(inp.rear * 100) / 100, e.rear);
        bar('icl', Math.round(inp.clutch * 100) / 100, e.clutch);
        const ln = Math.round(inp.lean * 50);
        if (last.ilean !== ln) { last.ilean = ln; e.lean.style.transform = 'translateX(' + (ln * 1.1) + 'px)'; }
        const rd = Math.round(-inp.rider * 45);
        if (last.irider !== rd) { last.irider = rd; e.rider.style.transform = 'translateY(' + (rd * 0.7) + 'px)'; }
        const tc = S.gameplay.tractionControl, ac = S.gameplay.autoClutch, as = S.gameplay.autoShift, tcOn = tc && p.tcCut > 0.05;
        const tags = (tc ? (tcOn ? 'T' : 't') : '') + (ac ? 'C' : '') + (as ? 'A' : '');
        if (last.tags !== tags) {
          last.tags = tags;
          e.assist.innerHTML = (tc ? `<span class="${tcOn ? 'on' : ''}">TC</span>` : '') + (ac ? '<span>AUTO CLUTCH</span>' : '') + (as ? '<span>AUTO SHIFT</span>' : '');
        }
      }
      // air time
      if (this.airT > 0) { this.airT -= dt; if (this.airT <= 0) e.air.classList.remove('show'); }
      // crash
      const crashed = !!p.crashed;
      if (last.crash !== crashed) { last.crash = crashed; e.crash.classList.toggle('show', crashed); }
      if (crashed) {
        const reason = p.crash.reason.toUpperCase();
        if (last.creason !== reason) { last.creason = reason; e.crashReason.textContent = reason; }
        const left = Math.max(0, Math.ceil(game.autoResetIn)), kind = game.input.promptKind();
        if (last.cleft !== left || last.ckind !== kind) {
          last.cleft = left; last.ckind = kind;
          const btn = kind === 'kb' ? MX.keyLabel((S.keyboard.bindings.reset || [])[0]) : game.input.bindingLabel(S.controller.bindings.reset, kind);
          e.crashHint.textContent = `Press ${btn} to reset · auto in ${left}`;
        }
      }
      // fps
      if (S.graphics.showFps) {
        this.fpsAcc = (this.fpsAcc || 0) + dt; this.fpsN = (this.fpsN || 0) + 1;
        if (this.fpsAcc > 0.5) {
          const res = S.graphics.dynamicRes ? ' · ' + Math.round(game.dyn.scale * 100) + '% res' : '';
          e.fps.textContent = Math.round(this.fpsN / this.fpsAcc) + ' FPS · ' + game.physSteps + ' steps' + res;
          this.fpsAcc = 0; this.fpsN = 0;
        }
      } else if (e.fps.textContent) e.fps.textContent = '';
      // minimap dot
      if (this.mapT) {
        const P = p.crashed ? p.crash.rider.pos : p.pos;
        this.mapT(P.x, P.z, _mp);
        const mx = Math.round(_mp[0] * 0.85 * 2) / 2, my = Math.round(_mp[1] * 0.85 * 2) / 2;
        if (last.mx !== mx || last.my !== my) { last.mx = mx; last.my = my; this.dot.style.transform = 'translate(' + mx + 'px,' + my + 'px)'; }
      }
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
