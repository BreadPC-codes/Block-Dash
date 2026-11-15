/* =====================================================================
   ROOST MX - procedural audio (Web Audio API).

   Engine: a looped buffer of synthesised exhaust pulses (one per
   revolution for a 2-stroke, one per two revolutions for a 4-stroke)
   replayed at a rate that follows the RPM. It feeds two paths, "on load"
   (bright, driven) and "off throttle" (muffled, with 4-stroke decel
   pops), crossfaded by throttle and load, plus intake/mechanical noise.
   Tyre roll, wind, skids, shifts, landings, bottoming and crashes are
   synthesised too, and a small procedural rock loop plays in the menus.
   ===================================================================== */
MX.module('audio', function (THREE, MX) {
  'use strict';
  const { clamp, lerp } = MX;

  class Audio {
    constructor(settings) {
      this.settings = settings;
      this.ctx = null;
      this.engine = null;
      this.music = null;
      this.ready = false;
    }

    unlock() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      const c = this.ctx;
      this.master = c.createGain();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
      this.master.connect(comp); comp.connect(c.destination);
      this.engineBus = c.createGain(); this.engineBus.connect(this.master);
      this.sfxBus = c.createGain(); this.sfxBus.connect(this.master);
      this.musicBus = c.createGain(); this.musicBus.connect(this.master);
      this.noiseBuf = this._noiseBuffer(2);
      this.applyVolumes();
      this.ready = true;
      if (this._wantMusic) this.startMusic();
    }

    applyVolumes() {
      if (!this.ctx) return;
      const a = this.settings.audio, t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(a.master, t, 0.05);
      this.engineBus.gain.setTargetAtTime(a.engine * 0.9, t, 0.05);
      this.sfxBus.gain.setTargetAtTime(a.effects, t, 0.05);
      this.musicBus.gain.setTargetAtTime(a.music * 0.55 * (this._musicDuck == null ? 1 : this._musicDuck), t, 0.2);
    }

    _noiseBuffer(sec) {
      const c = this.ctx, n = Math.floor(c.sampleRate * sec);
      const b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = last * 0.6 + w * 0.4; d[i] = last * 1.6; }
      return b;
    }

    // one engine cycle repeated with jitter; f0 = cycles per second at rate 1
    _engineBuffer(stroke) {
      const c = this.ctx, sr = c.sampleRate;
      const f0 = stroke === 2 ? 60 : 40;
      const cycles = 16;
      const n = Math.floor(sr * cycles / f0);
      const b = c.createBuffer(1, n, sr), d = b.getChannelData(0);
      const rnd = MX.rng(stroke * 991);
      const T = n / cycles;
      for (let k = 0; k < cycles; k++) {
        const amp = 0.85 + rnd() * 0.3;
        const start = Math.floor(k * T + (rnd() - 0.5) * T * 0.04);
        const ring1 = stroke === 2 ? 5.2 + rnd() * 0.4 : 3.4 + rnd() * 0.3;   // in multiples of f0
        const ring2 = stroke === 2 ? 11.5 : 7.1;
        const tau = stroke === 2 ? 0.28 : 0.42;   // fraction of a cycle
        for (let j = 0; j < T * 1.4; j++) {
          const idx = (start + j) % n;
          const ph = j / T;                       // 0..1.4 cycles
          const env = Math.exp(-ph / tau);
          let v = 0;
          v += Math.sin(2 * Math.PI * ph * ring1) * env * 0.9;
          v += Math.sin(2 * Math.PI * ph * ring2 + 0.7) * Math.exp(-ph / (tau * 0.5)) * (stroke === 2 ? 0.55 : 0.32);
          v += (ph < 0.06 ? (1 - ph / 0.06) : 0) * 1.4;         // the bang
          v += (rnd() * 2 - 1) * env * (stroke === 2 ? 0.35 : 0.22);
          d[idx] += v * amp;
        }
        // low "thump" body of the cycle
        for (let j = 0; j < T; j++) {
          const idx = (start + j) % n;
          d[idx] += Math.sin(2 * Math.PI * j / T) * (stroke === 2 ? 0.25 : 0.55) * Math.exp(-j / T * 1.5);
        }
      }
      let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(d[i]));
      for (let i = 0; i < n; i++) d[i] /= mx;
      return { buffer: b, f0 };
    }

    _shaper(amount) {
      const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount) / Math.tanh(amount); }
      const ws = this.ctx.createWaveShaper(); ws.curve = curve; ws.oversample = '2x';
      return ws;
    }

    startEngine(spec) {
      if (!this.ctx) return;
      this.stopEngine();
      const c = this.ctx, stroke = spec.stroke;
      const eb = this._engineBuffer(stroke);
      const src = c.createBufferSource(); src.buffer = eb.buffer; src.loop = true;
      // load path
      const loadPre = c.createGain(); loadPre.gain.value = 1.0;
      const shaper = this._shaper(stroke === 2 ? 3.2 : 2.4);
      const loadLP = c.createBiquadFilter(); loadLP.type = 'lowpass'; loadLP.Q.value = 0.9;
      const loadPeak = c.createBiquadFilter(); loadPeak.type = 'peaking'; loadPeak.gain.value = stroke === 2 ? 7 : 4; loadPeak.Q.value = 1.6;
      const loadG = c.createGain(); loadG.gain.value = 0;
      src.connect(loadPre); loadPre.connect(shaper); shaper.connect(loadPeak); loadPeak.connect(loadLP); loadLP.connect(loadG); loadG.connect(this.engineBus);
      // off-throttle path
      const offLP = c.createBiquadFilter(); offLP.type = 'lowpass'; offLP.Q.value = 0.6;
      const offG = c.createGain(); offG.gain.value = 0;
      src.connect(offLP); offLP.connect(offG); offG.connect(this.engineBus);
      // low body (sub thump)
      const bodyLP = c.createBiquadFilter(); bodyLP.type = 'lowpass'; bodyLP.frequency.value = 180;
      const bodyG = c.createGain(); bodyG.gain.value = 0.4;
      src.connect(bodyLP); bodyLP.connect(bodyG); bodyG.connect(this.engineBus);
      // intake / mechanical noise
      const nz = c.createBufferSource(); nz.buffer = this.noiseBuf; nz.loop = true;
      const nzBP = c.createBiquadFilter(); nzBP.type = 'bandpass'; nzBP.Q.value = 1.2;
      const nzG = c.createGain(); nzG.gain.value = 0;
      nz.connect(nzBP); nzBP.connect(nzG); nzG.connect(this.engineBus);
      // tyres / wind / skid
      const roll = c.createBufferSource(); roll.buffer = this.noiseBuf; roll.loop = true; roll.playbackRate.value = 0.7;
      const rollLP = c.createBiquadFilter(); rollLP.type = 'lowpass'; rollLP.frequency.value = 300;
      const rollG = c.createGain(); rollG.gain.value = 0;
      roll.connect(rollLP); rollLP.connect(rollG); rollG.connect(this.sfxBus);
      const wind = c.createBufferSource(); wind.buffer = this.noiseBuf; wind.loop = true; wind.playbackRate.value = 1.3;
      const windBP = c.createBiquadFilter(); windBP.type = 'bandpass'; windBP.frequency.value = 600; windBP.Q.value = 0.5;
      const windG = c.createGain(); windG.gain.value = 0;
      wind.connect(windBP); windBP.connect(windG); windG.connect(this.sfxBus);
      const skid = c.createBufferSource(); skid.buffer = this.noiseBuf; skid.loop = true;
      const skidBP = c.createBiquadFilter(); skidBP.type = 'bandpass'; skidBP.frequency.value = 1100; skidBP.Q.value = 0.9;
      const skidG = c.createGain(); skidG.gain.value = 0;
      skid.connect(skidBP); skidBP.connect(skidG); skidG.connect(this.sfxBus);
      const now = c.currentTime;
      [src, nz, roll, wind, skid].forEach((s) => s.start(now + Math.random() * 0.01));
      this.engine = { src, loadG, offG, loadLP, loadPeak, offLP, bodyG, nzBP, nzG, rollG, rollLP, windG, windBP, skidG, skidBP, f0: eb.f0, stroke, nodes: [src, nz, roll, wind, skid], popT: 0, lastGear: null };
    }

    stopEngine() {
      if (!this.engine) return;
      const e = this.engine, t = this.ctx.currentTime;
      for (const g of [e.loadG, e.offG, e.bodyG, e.nzG, e.rollG, e.windG, e.skidG]) g.gain.setTargetAtTime(0, t, 0.05);
      for (const s of e.nodes) { try { s.stop(t + 0.3); } catch (er) { /* */ } }
      this.engine = null;
    }

    // per-frame engine update from physics
    updateEngine(phys, dt, paused) {
      const e = this.engine;
      if (!e || !this.ctx) return;
      const c = this.ctx, t = c.currentTime;
      const en = phys.engine;
      const rpm = phys.crashed ? Math.max(0, en.w * 30 / Math.PI) : en.w * 30 / Math.PI;
      const running = !en.stalled && rpm > 200 && !paused;
      const cyc = (rpm / 60) / (e.stroke === 2 ? 1 : 2);
      const rate = clamp(cyc / e.f0, 0.05, 6);
      e.src.playbackRate.setTargetAtTime(rate, t, 0.015);
      const thr = phys.crashed ? 0 : en.thrEff;
      const load = clamp(en.load * 0.7 + thr * 0.3, 0, 1);
      const rn = rpm / phys.eng.limit;
      // limiter: chop the sound
      const chop = en.limiter && (Math.floor(t * 28) % 2 === 0) ? 0.35 : 1;
      const on = running ? (0.25 + 0.75 * load) * (0.55 + 0.45 * rn) * chop : 0;
      const off = running ? (1 - load * 0.85) * (0.35 + 0.4 * rn) * 0.55 : 0;
      e.loadG.gain.setTargetAtTime(on * 0.55, t, 0.03);
      e.offG.gain.setTargetAtTime(off * 0.6, t, 0.05);
      e.bodyG.gain.setTargetAtTime(running ? 0.35 + 0.25 * load : 0, t, 0.05);
      e.loadLP.frequency.setTargetAtTime(900 + 5200 * load * (0.4 + 0.6 * rn) + 600 * rn, t, 0.03);
      e.loadPeak.frequency.setTargetAtTime(e.stroke === 2 ? 1600 + 2400 * rn : 600 + 900 * rn, t, 0.05);
      e.offLP.frequency.setTargetAtTime(380 + 900 * rn, t, 0.05);
      e.nzBP.frequency.setTargetAtTime(500 + rpm * 0.35, t, 0.05);
      e.nzG.gain.setTargetAtTime(running ? (0.03 + 0.1 * thr) * (0.4 + rn) : 0, t, 0.05);
      // tyres, wind and skid
      const speed = paused ? 0 : phys.speed;
      const grounded = phys.wheels[0].contact || phys.wheels[1].contact;
      e.rollG.gain.setTargetAtTime(grounded ? clamp(speed / 25, 0, 1) * 0.35 : 0, t, 0.05);
      e.rollLP.frequency.setTargetAtTime(200 + speed * 40, t, 0.1);
      e.windG.gain.setTargetAtTime(clamp(speed * speed / 900, 0, 1) * 0.22 * (phys.airborne ? 1.4 : 1), t, 0.1);
      e.windBP.frequency.setTargetAtTime(400 + speed * 25, t, 0.1);
      let slide = 0;
      for (const w of phys.wheels) if (w.contact) slide = Math.max(slide, clamp((w.slideAmt || 0) * 0.6 + (w.locked ? 0.7 : 0), 0, 1));
      e.skidG.gain.setTargetAtTime(paused ? 0 : slide * clamp(speed / 6, 0, 1) * 0.45, t, 0.04);
      // 4-stroke decel pops
      if (running && e.stroke === 4 && thr < 0.08 && rn > 0.45) {
        e.popT -= dt;
        if (e.popT <= 0) { e.popT = 0.04 + Math.random() * 0.25; if (Math.random() < 0.55) this._pop(0.12 + Math.random() * 0.12); }
      }
    }

    _env(g, t, a, peak, d) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    }
    _noiseShot(t, dur, type, freq, q, peak, bus) {
      const c = this.ctx;
      const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.playbackRate.value = 0.8 + Math.random() * 0.4;
      const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain();
      s.connect(f); f.connect(g); g.connect(bus || this.sfxBus);
      this._env(g, t, 0.004, peak, dur);
      s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
    }
    _tone(t, type, f0, f1, dur, peak, bus) {
      const c = this.ctx;
      const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      const g = c.createGain();
      o.connect(g); g.connect(bus || this.sfxBus);
      this._env(g, t, 0.005, peak, dur);
      o.start(t); o.stop(t + dur + 0.05);
    }
    _pop(v) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this._noiseShot(t, 0.05, 'bandpass', 700 + Math.random() * 500, 1.5, v, this.engineBus);
    }

    // ---- one-shots
    shift(up) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this._noiseShot(t, 0.05, 'lowpass', 900, 0.7, 0.25);
      this._tone(t, 'sine', up ? 120 : 95, 60, 0.07, 0.25);
    }
    land(strength) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, k = clamp(strength / 9, 0.1, 1.2);
      this._tone(t, 'sine', 95, 38, 0.32, 0.55 * k);
      this._noiseShot(t, 0.18, 'lowpass', 420, 0.8, 0.45 * k);
      if (strength > 6) this._noiseShot(t + 0.03, 0.12, 'bandpass', 2400, 3, 0.18 * k); // suspension clank
    }
    bottom(strength) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this._noiseShot(t, 0.1, 'bandpass', 1800, 4, 0.3 * clamp(strength, 0.3, 1));
      this._tone(t, 'triangle', 620, 520, 0.18, 0.08);
    }
    crash() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      for (let i = 0; i < 5; i++) {
        this._noiseShot(t + i * 0.09 + Math.random() * 0.05, 0.2, 'lowpass', 600 + Math.random() * 1200, 0.8, 0.5 - i * 0.07);
        this._tone(t + i * 0.1, 'sine', 80, 40, 0.25, 0.4 - i * 0.06);
      }
      this._noiseShot(t + 0.05, 0.4, 'bandpass', 3000, 2, 0.15);
    }
    ui(kind) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      if (kind === 'hover') this._tone(t, 'triangle', 1350, 1250, 0.035, 0.05);
      else if (kind === 'select') { this._tone(t, 'triangle', 660, 660, 0.05, 0.1); this._tone(t + 0.05, 'triangle', 990, 990, 0.08, 0.1); }
      else if (kind === 'back') { this._tone(t, 'triangle', 700, 700, 0.05, 0.08); this._tone(t + 0.05, 'triangle', 470, 470, 0.08, 0.08); }
      else if (kind === 'lap') { [523, 659, 784, 1046].forEach((f, i) => this._tone(t + i * 0.09, 'triangle', f, f, 0.22, 0.12)); }
      else if (kind === 'best') { [659, 784, 988, 1318].forEach((f, i) => this._tone(t + i * 0.08, 'square', f, f, 0.18, 0.06)); }
      else if (kind === 'error') { this._tone(t, 'square', 180, 150, 0.12, 0.06); }
    }

    // ---- music: a small procedural rock loop (E minor), lookahead scheduler
    startMusic() {
      this._wantMusic = true;
      if (!this.ctx || this.music) return;
      const c = this.ctx;
      const bpm = 132, step = 60 / bpm / 4;
      const out = c.createGain(); out.gain.value = 0; out.connect(this.musicBus);
      out.gain.setTargetAtTime(1, c.currentTime, 0.8);
      const drive = this._shaper(4); const gLP = c.createBiquadFilter(); gLP.type = 'lowpass'; gLP.frequency.value = 2600;
      const gG = c.createGain(); gG.gain.value = 0.12; drive.connect(gLP); gLP.connect(gG); gG.connect(out);
      const m = this.music = { out, drive, step, next: c.currentTime + 0.1, i: 0, timer: null };
      const N = (n) => 440 * Math.pow(2, (n - 69) / 12);
      const prog = [[40, 47, 52], [36, 43, 48], [43, 50, 55], [38, 45, 50]]; // Em C G D (power chords)
      const bassRiff = [0, 0, 12, 0, 0, 10, 0, 7, 0, 0, 12, 0, 3, 0, 5, 7];
      const sched = () => {
        while (m.next < c.currentTime + 0.25) {
          const t = m.next, i = m.i, bar = Math.floor(i / 16) % 4, s = i % 16;
          const ch = prog[bar];
          if (s % 8 === 0 || s === 10) this._kick(t, out);
          if (s % 8 === 4) this._snare(t, out);
          this._hat(t, out, s % 2 === 0 ? 0.05 : 0.025);
          const bn = ch[0] - 12 + bassRiff[s];
          this._bass(t, N(bn), step * 0.9, out);
          if (s === 0 || s === 6 || s === 10) this._guitar(t, ch.map(N), s === 0 ? step * 5.5 : step * 3.5, drive);
          m.i++; m.next += step;
        }
      };
      m.timer = setInterval(sched, 60);
      sched();
    }
    stopMusic() {
      this._wantMusic = false;
      if (!this.music || !this.ctx) return;
      const m = this.music; this.music = null;
      m.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
      clearInterval(m.timer);
      setTimeout(() => { try { m.out.disconnect(); } catch (e) { /* */ } }, 2500);
    }
    duckMusic(k) { this._musicDuck = k; this.applyVolumes(); }
    _kick(t, out) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      o.connect(g); g.connect(out); this._env(g, t, 0.003, 0.9, 0.22); o.start(t); o.stop(t + 0.3);
    }
    _snare(t, out) { this._noiseShot(t, 0.16, 'bandpass', 1900, 0.8, 0.38, out); this._tone(t, 'triangle', 190, 160, 0.08, 0.2, out); }
    _hat(t, out, v) { this._noiseShot(t, 0.035, 'highpass', 7500, 0.7, v, out); }
    _bass(t, f, d, out) {
      const c = this.ctx, o = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.value = f; lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 2;
      o.connect(lp); lp.connect(g); g.connect(out); this._env(g, t, 0.005, 0.3, d); o.start(t); o.stop(t + d + 0.05);
    }
    _guitar(t, freqs, d, into) {
      const c = this.ctx;
      for (const f of freqs) for (const det of [-6, 5]) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sawtooth'; o.frequency.value = f * 2; o.detune.value = det;
        o.connect(g); g.connect(into);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.setTargetAtTime(0.0001, t + d * 0.7, d * 0.2);
        o.start(t); o.stop(t + d + 0.3);
      }
    }
  }

  MX.Audio = Audio;
});
