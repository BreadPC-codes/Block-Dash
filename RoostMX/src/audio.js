// Procedural audio with the Web Audio API: a single-cylinder four-stroke engine
// synthesised in an AudioWorklet (combustion pulses exciting exhaust resonances), with
// an oscillator fallback, plus wind, tire, roost, landing, crash and menu sounds.

const WORKLET = `
class RoostEngine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 1800, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.phase = 0; this.t = 1; this.amp = 0; this.seed = 22222;
    this.lp = 0; this.lp2 = 0; this.hp = 0; this.prev = 0; this.nlp = 0;
    this.g = 0; this.rpm = 1800; this.load = 0; this.mech = 0; this.backfire = 0;
  }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  process(inputs, outputs, params) {
    const out = outputs[0];
    const ch = out[0];
    if (!ch) return true;
    const sr = sampleRate;
    const tRpm = params.rpm[0], tLoad = params.load[0], tGain = params.gain[0];
    for (let i = 0; i < ch.length; i++) {
      this.rpm += (tRpm - this.rpm) * 0.0015;
      this.load += (tLoad - this.load) * 0.002;
      this.g += (tGain - this.g) * 0.001;
      const rpm = this.rpm, load = this.load;
      const fire = rpm / 120;
      this.phase += fire / sr;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.t = 0;
        const off = load < 0.08 && rpm > 4000;
        this.amp = (off ? 0.22 + this.rnd() * 0.35 : 0.42 + 0.58 * load) * (0.86 + this.rnd() * 0.28);
        if (off && this.rnd() < 0.06) this.backfire = 1;
      }
      this.t += 1 / sr;
      const t = this.t;
      const fres = 80 + rpm * 0.026;
      const dec = Math.exp(-t * (95 + rpm * 0.011));
      let s = this.amp * dec * (Math.sin(6.2832 * fres * t) + 0.55 * Math.sin(6.2832 * fres * 2.07 * t) + 0.25 * Math.sin(6.2832 * fres * 3.4 * t));
      // initial pressure kick
      s += this.amp * Math.exp(-t * 900) * 1.3;
      // valvetrain / mechanical noise
      const n = this.rnd() * 2 - 1;
      this.nlp += (n - this.nlp) * 0.35;
      s += this.nlp * (0.025 + 0.08 * load) * Math.min(1, rpm / 9000);
      if (this.backfire > 0.001) { s += (this.rnd() * 2 - 1) * this.backfire * 0.9; this.backfire *= 0.995; }
      // tone shaping: lowpass depends on load and rpm
      const cut = 0.04 + 0.22 * load + rpm / 90000;
      this.lp += (s - this.lp) * Math.min(0.95, cut);
      this.lp2 += (this.lp - this.lp2) * Math.min(0.95, cut * 1.6);
      // dc block
      const y = this.lp2 - this.prev + 0.995 * this.hp;
      this.prev = this.lp2; this.hp = y;
      const v = Math.tanh(y * 2.2) * this.g;
      for (let c = 0; c < out.length; c++) out[c][i] = v;
    }
    return true;
  }
}
registerProcessor('roost-engine', RoostEngine);
`;

export class AudioSystem {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    this.engineNode = null;
    this.fallback = null;
    this.lastClick = 0;
  }

  /** Must be called from a user gesture. */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.engineBus = ctx.createGain();
    this.fxBus = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    this.engineBus.connect(this.master);
    this.fxBus.connect(this.master);
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.applyVolumes();
    // noise buffer
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // continuous layers: wind, skid, roost
    this.wind = this._loop(ctx, 'lowpass', 500, 0.6);
    this.skid = this._loop(ctx, 'bandpass', 1700, 2.2);
    this.roost = this._loop(ctx, 'bandpass', 420, 0.9);
    this.rumble = this._loop(ctx, 'lowpass', 140, 0.7);
    // engine
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } catch (blobErr) {
        // pages opened from file:// cannot load blob: worklets, but data: URLs work
        const bytes = new TextEncoder().encode(WORKLET);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        await ctx.audioWorklet.addModule('data:application/javascript;base64,' + btoa(bin));
      } finally {
        URL.revokeObjectURL(url);
      }
      this.engineNode = new AudioWorkletNode(ctx, 'roost-engine', { outputChannelCount: [2] });
      const body = ctx.createBiquadFilter();
      body.type = 'peaking';
      body.frequency.value = 160;
      body.Q.value = 0.9;
      body.gain.value = 5;
      const air = ctx.createBiquadFilter();
      air.type = 'highshelf';
      air.frequency.value = 3000;
      air.gain.value = -6;
      this.engineNode.connect(body);
      body.connect(air);
      air.connect(this.engineBus);
    } catch (e) {
      console.warn('AudioWorklet unavailable, using oscillator engine', e);
      this._fallbackEngine();
    }
    this.ready = true;
  }

  _loop(ctx, type, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(this.fxBus);
    src.start();
    return { src, f, g };
  }

  _fallbackEngine() {
    const ctx = this.ctx;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    o1.connect(f);
    o2.connect(g2);
    g2.connect(f);
    f.connect(g);
    g.connect(this.engineBus);
    o1.start();
    o2.start();
    this.fallback = { o1, o2, f, g };
  }

  applyVolumes() {
    if (!this.ctx) return;
    const a = this.settings.audio;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(a.master, t, 0.05);
    this.engineBus.gain.setTargetAtTime(a.engine * 0.9, t, 0.05);
    this.fxBus.gain.setTargetAtTime(a.effects, t, 0.05);
  }

  /** Called every frame while riding (or idling in menus). */
  updateRide(p) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const on = p.engineOn ? 1 : 0;
    const proximity = p.cameraMode === 'helmet' ? 1.15 : p.cameraMode === 'close' ? 1 : 0.85;
    if (this.engineNode) {
      const P = this.engineNode.parameters;
      P.get('rpm').setTargetAtTime(Math.max(300, p.rpm), t, 0.02);
      P.get('load').setTargetAtTime(p.load, t, 0.03);
      P.get('gain').setTargetAtTime(on * 0.55 * proximity, t, 0.08);
    } else if (this.fallback) {
      const fire = p.rpm / 120;
      this.fallback.o1.frequency.setTargetAtTime(fire * 2, t, 0.02);
      this.fallback.o2.frequency.setTargetAtTime(fire, t, 0.02);
      this.fallback.f.frequency.setTargetAtTime(300 + p.load * 1800 + p.rpm * 0.08, t, 0.05);
      this.fallback.g.gain.setTargetAtTime(on * (0.08 + 0.12 * p.load) * proximity, t, 0.05);
    }
    const sp = p.speed;
    this.wind.g.gain.setTargetAtTime(Math.min(0.5, (sp * sp) / 2600) * (p.cameraMode === 'helmet' ? 1.4 : 1), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(300 + sp * 25, t, 0.1);
    this.skid.g.gain.setTargetAtTime(Math.min(0.35, p.skid * 0.05), t, 0.04);
    this.skid.f.frequency.setTargetAtTime(p.surface === 'sand' ? 900 : 1600, t, 0.2);
    this.roost.g.gain.setTargetAtTime(Math.min(0.4, p.roost * 0.06), t, 0.05);
    this.rumble.g.gain.setTargetAtTime(Math.min(0.35, p.rough * 0.9 + (p.grounded ? sp * 0.004 : 0)), t, 0.06);
  }

  silenceRide() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (this.engineNode) this.engineNode.parameters.get('gain').setTargetAtTime(0, t, 0.1);
    if (this.fallback) this.fallback.g.gain.setTargetAtTime(0, t, 0.1);
    for (const l of [this.wind, this.skid, this.roost, this.rumble]) l.g.gain.setTargetAtTime(0, t, 0.1);
  }

  // --- one shots -------------------------------------------------------------------
  _burst(dur, type, freq, q, gain, bus = this.fxBus, attack = 0.005) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(bus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  _tone(freq, dur, type, gain, sweepTo = 0, bus = this.fxBus, delay = 0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  land(impact) {
    const k = Math.min(1, impact / 10);
    this._tone(85, 0.25 + k * 0.2, 'sine', 0.25 + k * 0.5, 38);
    this._burst(0.22 + k * 0.2, 'lowpass', 350 + k * 300, 0.8, 0.2 + k * 0.4);
    if (k > 0.6) this._burst(0.12, 'bandpass', 2200, 3, 0.15 * k);
  }

  crash() {
    this._burst(0.9, 'lowpass', 600, 0.7, 0.8);
    this._tone(70, 0.5, 'sine', 0.7, 30);
    this._burst(0.35, 'bandpass', 2600, 2.5, 0.35, this.fxBus, 0.002);
    setTimeout(() => { this._tone(60, 0.3, 'sine', 0.45, 32); this._burst(0.3, 'lowpass', 500, 0.8, 0.35); }, 260);
  }

  bump(amount) {
    this._tone(70, 0.18, 'sine', Math.min(0.6, amount * 0.08), 40);
  }

  takeoff(speed) {
    // short air rush as the bike leaves the lip
    const k = Math.min(1, speed / 20);
    this._burst(0.5, 'bandpass', 700 + k * 500, 0.7, 0.12 + k * 0.12, this.fxBus, 0.04);
  }

  shift() {
    this._burst(0.05, 'bandpass', 3200, 6, 0.12);
    this._tone(180, 0.05, 'square', 0.05, 120);
  }

  scrape() {
    const now = performance.now();
    if (now - this.lastClick < 120) return;
    this.lastClick = now;
    this._burst(0.15, 'bandpass', 3800, 4, 0.12);
  }

  uiHover() {
    this._tone(1400, 0.05, 'sine', 0.04);
  }

  uiSelect() {
    this._tone(880, 0.07, 'triangle', 0.09);
    this._tone(1320, 0.1, 'triangle', 0.08, 0, this.fxBus, 0.06);
  }

  uiBack() {
    this._tone(700, 0.08, 'triangle', 0.08, 500);
  }

  beep(high) {
    this._tone(high ? 1320 : 880, high ? 0.45 : 0.16, 'square', 0.08);
  }

  gateDrop() {
    this._burst(0.25, 'bandpass', 1500, 2, 0.4);
    this._tone(200, 0.2, 'square', 0.12, 90);
  }

  checkpoint() {
    this._tone(1046, 0.09, 'sine', 0.08);
    this._tone(1568, 0.12, 'sine', 0.07, 0, this.fxBus, 0.07);
  }

  bestLap() {
    [523, 659, 784, 1046].forEach((f, i) => this._tone(f, 0.22, 'triangle', 0.1, 0, this.fxBus, i * 0.09));
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
}
