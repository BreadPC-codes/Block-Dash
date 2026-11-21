/* =====================================================================
   ROOST MX - input: keyboard, mouse and gamepads (Gamepad API).

   - Keyboard keys ramp like real hands on levers (no instant 0→1).
   - Gamepads are read as true analog values: trigger pressure, stick
     position, radial dead zones, response curves, light smoothing.
   - Everything is remappable; bindings live in the settings.
   - Works with keyboard and pad at the same time; the device used last
     decides which button prompts the UI shows.
   ===================================================================== */
MX.module('input', function (THREE, MX) {
  'use strict';
  const { clamp } = MX;

  const ACTIONS = [
    { id: 'throttle', label: 'Accelerate', kb: true, pad: 'trigger' },
    { id: 'front', label: 'Front brake', kb: true, pad: 'trigger' },
    { id: 'rear', label: 'Rear brake', kb: true, pad: 'trigger' },
    { id: 'clutch', label: 'Clutch', kb: true, pad: 'trigger' },
    { id: 'leanLeft', label: 'Lean left', kb: true },
    { id: 'leanRight', label: 'Lean right', kb: true },
    { id: 'lean', label: 'Lean (stick)', pad: 'axis' },
    { id: 'riderFwd', label: 'Rider forward', kb: true },
    { id: 'riderBack', label: 'Rider backward', kb: true },
    { id: 'rider', label: 'Rider forward/back (stick)', pad: 'axis' },
    { id: 'shiftUp', label: 'Shift up', kb: true, pad: 'button' },
    { id: 'shiftDown', label: 'Shift down', kb: true, pad: 'button' },
    { id: 'camera', label: 'Change camera', kb: true, pad: 'button' },
    { id: 'reset', label: 'Reset bike', kb: true, pad: 'button' },
    { id: 'pause', label: 'Pause', kb: true, pad: 'button' },
    { id: 'lookLeft', label: 'Look left', kb: true },
    { id: 'lookRight', label: 'Look right', kb: true },
    { id: 'camX', label: 'Camera left/right (stick)', pad: 'axis' },
    { id: 'camY', label: 'Camera up/down (stick)', pad: 'axis' },
  ];
  MX.INPUT_ACTIONS = ACTIONS;

  MX.defaultKeys = () => ({
    throttle: ['KeyW'], rear: ['KeyS'], leanLeft: ['KeyA'], leanRight: ['KeyD'], front: ['Space'],
    clutch: ['ShiftLeft', 'ShiftRight'], shiftUp: ['KeyE'], shiftDown: ['KeyQ'],
    riderFwd: ['ArrowUp'], riderBack: ['ArrowDown'], camera: ['KeyC'], reset: ['KeyR'], pause: ['Escape', 'KeyP'],
    lookLeft: ['ArrowLeft'], lookRight: ['ArrowRight'],
  });
  MX.defaultPad = () => ({
    throttle: { t: 'b', i: 7 }, front: { t: 'b', i: 6 }, rear: { t: 'b', i: 2 }, clutch: { t: 'b', i: 0 },
    shiftUp: { t: 'b', i: 5 }, shiftDown: { t: 'b', i: 4 }, camera: { t: 'b', i: 3 }, reset: { t: 'b', i: 1 }, pause: { t: 'b', i: 9 },
    lean: { t: 'a', i: 0 }, rider: { t: 'a', i: 1, inv: true }, camX: { t: 'a', i: 2 }, camY: { t: 'a', i: 3 },
  });
  // Firefox/Linux & some drivers expose pads without the "standard" mapping:
  // triggers as axes 2/5 (resting at -1), right stick on axes 3/4.
  const legacyPad = () => ({
    throttle: { t: 'a', i: 5, rest: -1 }, front: { t: 'a', i: 2, rest: -1 }, rear: { t: 'b', i: 2 }, clutch: { t: 'b', i: 0 },
    shiftUp: { t: 'b', i: 5 }, shiftDown: { t: 'b', i: 4 }, camera: { t: 'b', i: 3 }, reset: { t: 'b', i: 1 }, pause: { t: 'b', i: 7 },
    lean: { t: 'a', i: 0 }, rider: { t: 'a', i: 1, inv: true }, camX: { t: 'a', i: 3 }, camY: { t: 'a', i: 4 },
  });

  function padKind(id) {
    const s = (id || '').toLowerCase();
    if (/045e|xbox|xinput|x-box/.test(s)) return 'xbox';
    if (/054c|playstation|dualshock|dualsense|ps4|ps5|wireless controller/.test(s)) return 'ps';
    return 'generic';
  }
  MX.padKind = padKind;

  // button labels for prompts
  const LABELS = {
    xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D↑', 'D↓', 'D←', 'D→', 'Xbox'],
    ps: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→', 'PS'],
    generic: ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'D↑', 'D↓', 'D←', 'D→', 'B16'],
  };
  const AXIS_NAMES = ['Left stick ↔', 'Left stick ↕', 'Right stick ↔', 'Right stick ↕', 'Axis 4', 'Axis 5', 'Axis 6', 'Axis 7'];

  function keyLabel(code) {
    if (!code) return '—';
    const map = { Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab' };
    if (map[code]) return map[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code;
  }
  MX.keyLabel = keyLabel;

  const PAD_ACTIONS = ['shiftUp', 'shiftDown', 'camera', 'reset', 'pause'];
  const NAV_KEYS = ['confirm', 'back', 'tabPrev', 'tabNext', 'start'];
  const NAV_PREV = NAV_KEYS.map((k) => 'nav_' + k);
  // keyboard key as a lever: ramp up while held, back down when released
  function ramp(cur, on, up, down, dt) { return on ? Math.min(1, cur + up * dt) : Math.max(0, cur - down * dt); }
  // trigger with a dead zone and a slight curve
  function padTrigger(v, tdz, sens) { v = v < tdz ? 0 : (v - tdz) / (1 - tdz); return clamp(Math.pow(v, 1.15) * sens, 0, 1); }
  // stick pair with a radial dead zone, written to out[0], out[1]
  function padStick(x, y, dz, out) {
    const m = Math.hypot(x, y);
    if (m < dz) { out[0] = 0; out[1] = 0; return out; }
    const k = (Math.min(1, m) - dz) / (1 - dz) / m;
    out[0] = x * k; out[1] = y * k;
    return out;
  }

  class Input {
    constructor(settings) {
      this.settings = settings;          // reference to the live settings object
      this.down = new Set();
      this.kb = { throttle: 0, front: 0, rear: 0, clutch: 0, lean: 0, rider: 0 };
      this.padState = { throttle: 0, front: 0, rear: 0, clutch: 0, lean: 0, rider: 0, camX: 0, camY: 0 };
      this.out = { throttle: 0, front: 0, rear: 0, clutch: 0, lean: 0, rider: 0, camX: 0, camY: 0 };
      this.pressed = new Set();          // actions pressed this frame
      this.nav = [];                     // menu navigation events this frame
      this.pads = {};
      this.activePad = null;
      this.lastDevice = 'kb';
      this.prevButtons = {};
      this.mouse = { dx: 0, dy: 0, wheel: 0, dragging: false };
      this.capture = null;
      this.navRepeat = { dir: null, t: 0 };
      this._rawPad = null;               // pad read this frame (for the settings tester)
      this._tgt = { throttle: 0, front: 0, rear: 0, clutch: 0, lean: 0, rider: 0, camX: 0, camY: 0 };
      this._nb = { confirm: false, back: false, tabPrev: false, tabNext: false, up: false, down: false, left: false, right: false, start: false };
      this._stick = [0, 0];
      this._bind();
    }

    // raw pad snapshot for the settings tester (built only when asked for)
    get raw() {
      const gp = this._rawPad;
      return gp ? { buttons: gp.buttons.map((b) => b.value), axes: gp.axes.slice(), id: gp.id, mapping: gp.mapping } : null;
    }

    get keys() { return this.settings.keyboard.bindings; }
    get padBindings() { return this.settings.controller.bindings; }

    _bind() {
      window.addEventListener('keydown', (e) => {
        if (this.capture && this.capture.device === 'key') {
          e.preventDefault();
          const cb = this.capture.cb; this.capture = null;
          cb(e.code === 'Escape' ? null : e.code, e.code);
          return;
        }
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' && e.target.type === 'text') return;
        this.lastDevice = 'kb';
        if (!e.repeat) {
          for (const id of Object.keys(this.keys)) if (this.keys[id].includes(e.code)) this.pressed.add(id);
          const navMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'confirm', Escape: 'back', Backspace: 'back', Tab: e.shiftKey ? 'tabPrev' : 'tabNext' };
          if (navMap[e.code]) this.nav.push({ type: navMap[e.code], device: 'kb' });
        } else {
          const navMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
          if (navMap[e.code]) this.nav.push({ type: navMap[e.code], device: 'kb', repeat: true });
        }
        this.down.add(e.code);
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code) && MX.state && MX.state.inGame) e.preventDefault();
        if (e.code === 'Tab') e.preventDefault();
      });
      window.addEventListener('keyup', (e) => { this.down.delete(e.code); });
      window.addEventListener('blur', () => { this.down.clear(); });
      window.addEventListener('gamepadconnected', (e) => this._padConnected(e.gamepad));
      window.addEventListener('gamepaddisconnected', (e) => this._padDisconnected(e.gamepad));
      window.addEventListener('wheel', (e) => { if (e.target && e.target.tagName === 'CANVAS') this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    }

    attachCanvas(canvas) {
      let lx = 0, ly = 0;
      canvas.addEventListener('pointerdown', (e) => { this.mouse.dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); this.lastDevice = 'kb'; });
      canvas.addEventListener('pointermove', (e) => { if (!this.mouse.dragging) return; this.mouse.dx += e.clientX - lx; this.mouse.dy += e.clientY - ly; lx = e.clientX; ly = e.clientY; });
      const up = () => { this.mouse.dragging = false; };
      canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _padConnected(gp) {
      if (!gp) return;
      const kind = padKind(gp.id);
      const existed = !!this.pads[gp.index];
      this.pads[gp.index] = { id: gp.id, kind, mapping: gp.mapping, index: gp.index };
      if (this.activePad == null) this.activePad = gp.index;
      // pads without the standard mapping: switch to the legacy layout unless the user remapped
      if (gp.mapping !== 'standard' && !this.settings.controller.custom) {
        this.settings.controller.bindings = legacyPad();
      } else if (gp.mapping === 'standard' && !this.settings.controller.custom) {
        this.settings.controller.bindings = MX.defaultPad();
      }
      if (!existed) MX.emit('pad', { type: 'connected', id: gp.id, kind, index: gp.index });
    }
    _padDisconnected(gp) {
      if (!gp || !this.pads[gp.index]) return;
      const info = this.pads[gp.index];
      delete this.pads[gp.index];
      if (this.activePad === gp.index) { const k = Object.keys(this.pads); this.activePad = k.length ? +k[0] : null; }
      MX.emit('pad', { type: 'disconnected', id: info.id, kind: info.kind, index: gp.index });
    }

    padInfo() { return this.activePad != null ? this.pads[this.activePad] : null; }
    promptKind() { const p = this.padInfo(); return this.lastDevice === 'pad' && p ? p.kind : 'kb'; }
    buttonLabel(i, kind) { return (LABELS[kind || (this.padInfo() || {}).kind || 'xbox'] || LABELS.generic)[i] || ('B' + i); }
    bindingLabel(b, kind) {
      if (!b) return '—';
      if (b.t === 'b') return this.buttonLabel(b.i, kind);
      if (b.t === 'a') {
        if (b.rest === -1) return (kind === 'ps' ? (b.i === 5 ? 'R2' : b.i === 2 ? 'L2' : 'Axis ' + b.i) : (b.i === 5 ? 'RT' : b.i === 2 ? 'LT' : 'Axis ' + b.i));
        return (AXIS_NAMES[b.i] || 'Axis ' + b.i) + (b.s ? (b.s > 0 ? ' +' : ' −') : '') + (b.inv ? ' (inv)' : '');
      }
      return '?';
    }

    // ---- remapping capture
    startCapture(device, cb) {
      if (device === 'pad') {
        const gp = this._gp();
        this.capture = { device, cb, base: gp ? { b: gp.buttons.map((x) => x.value), a: gp.axes.slice() } : null, t: 0 };
      } else this.capture = { device, cb };
    }
    cancelCapture() { this.capture = null; }

    _gp() {
      const list = navigator.getGamepads ? navigator.getGamepads() : [];
      if (!list) return null;
      let gp = this.activePad != null ? list[this.activePad] : null;
      if (!gp) for (const g of list) if (g && g.connected) { gp = g; break; }
      return gp;
    }

    // ---- per-frame update
    update(dt) {
      const list = navigator.getGamepads ? navigator.getGamepads() : null;
      // detect pads that appeared without events (Chrome) and pick the active one by activity
      if (list) for (let n = 0; n < list.length; n++) {
        const g = list[n];
        if (!g || !g.connected) continue;
        if (!this.pads[g.index]) this._padConnected(g);
        let any = Math.abs(g.axes[0] || 0) > 0.5 || Math.abs(g.axes[1] || 0) > 0.5;
        for (let b = 0; !any && b < g.buttons.length; b++) if (g.buttons[b].value > 0.5) any = true;
        if (any && this.activePad !== g.index) this.activePad = g.index;
      }
      for (const idx in this.pads) { if (!list || !list[idx]) this._padDisconnected({ index: +idx }); }
      const gp = this._gp();
      // keyboard ramps
      this._keyboard(dt);
      // gamepad
      const P = this.padState;
      this._rawPad = gp || null;
      if (gp) {
        if (this.capture && this.capture.device === 'pad') this._padCapture(gp, dt);
        else this._readPad(gp, dt);
      } else {
        for (const k in P) P[k] = 0;
      }
      // combine
      const O = this.out, K = this.kb;
      O.throttle = Math.max(K.throttle, P.throttle);
      O.front = Math.max(K.front, P.front);
      O.rear = Math.max(K.rear, P.rear);
      O.clutch = Math.max(K.clutch, P.clutch);
      O.lean = clamp(K.lean + P.lean, -1, 1);
      O.rider = clamp(K.rider + P.rider, -1, 1);
      const lookK = (this._any('lookRight') ? 1 : 0) - (this._any('lookLeft') ? 1 : 0);
      O.camX = P.camX + lookK;
      O.camY = P.camY;
    }

    _any(id) { const k = this.keys[id]; if (!k) return false; for (const c of k) if (this.down.has(c)) return true; return false; }

    _keyboard(dt) {
      const K = this.kb, S = this.settings;
      const sens = S.controller.steerSensitivity || 1;
      K.throttle = ramp(K.throttle, this._any('throttle'), 5.0, 9, dt);
      K.front = ramp(K.front, this._any('front'), 4.0, 10, dt);
      K.rear = ramp(K.rear, this._any('rear'), 6, 10, dt);
      K.clutch = ramp(K.clutch, this._any('clutch'), 9, 7, dt);
      const l = (this._any('leanRight') ? 1 : 0) - (this._any('leanLeft') ? 1 : 0);
      if (l !== 0) {
        const r = (Math.sign(K.lean) !== l && K.lean !== 0 ? 6 : 2.4) * (0.7 + 0.3 * sens);
        K.lean = clamp(K.lean + l * r * dt, -1, 1);
      } else K.lean = MX.approach(K.lean, 0, 4.5 * dt);
      const rf = (this._any('riderFwd') ? 1 : 0) - (this._any('riderBack') ? 1 : 0);
      if (rf !== 0) K.rider = clamp(K.rider + rf * 4 * dt, -1, 1); else K.rider = MX.approach(K.rider, 0, 4 * dt);
    }

    _axis(gp, b) {
      if (!b) return 0;
      if (b.t === 'b') { const btn = gp.buttons[b.i]; return btn ? btn.value : 0; }
      let v = gp.axes[b.i] || 0;
      if (b.rest === -1) return clamp((v + 1) / 2, 0, 1);
      if (b.s) return clamp(v * b.s, 0, 1);
      return b.inv ? -v : v;
    }

    _readPad(gp, dt) {
      const C = this.settings.controller, B = this.padBindings, P = this.padState;
      const dz = C.deadzone, tdz = C.triggerDeadzone;
      // sticks: radial dead zone where the pair is a real stick
      const st = this._stick;
      padStick(this._axis(gp, B.lean), this._axis(gp, B.rider), dz, st);
      const lx = st[0], ly = st[1];
      padStick(this._axis(gp, B.camX), this._axis(gp, B.camY), dz, st);
      const cx = st[0], cy = st[1];
      const sm = 1 - Math.exp(-dt * 30);
      const tgt = this._tgt;
      tgt.throttle = padTrigger(this._axis(gp, B.throttle), tdz, C.throttleSensitivity);
      tgt.front = padTrigger(this._axis(gp, B.front), tdz, C.brakeSensitivity);
      tgt.rear = padTrigger(this._axis(gp, B.rear), tdz, C.brakeSensitivity);
      tgt.clutch = padTrigger(this._axis(gp, B.clutch), tdz, 1);
      tgt.lean = Math.sign(lx) * clamp(Math.pow(Math.abs(lx), 1.35) * C.steerSensitivity, 0, 1);
      tgt.rider = clamp(ly, -1, 1);
      tgt.camX = cx * C.cameraSensitivity; tgt.camY = -cy * C.cameraSensitivity;
      for (const k in tgt) P[k] += (tgt[k] - P[k]) * sm;
      // instant release (smoothing must never make the bike keep accelerating)
      if (tgt.throttle === 0) P.throttle = Math.min(P.throttle, 0.02);
      // edges for button actions (two state objects per pad, swapped every frame)
      const pb = this.prevButtons[gp.index] || (this.prevButtons[gp.index] = [{}, {}, 0]);
      const prev = pb[pb[2]], now = pb[1 - pb[2]];
      pb[2] = 1 - pb[2];
      for (let a = 0; a < PAD_ACTIONS.length; a++) {
        const id = PAD_ACTIONS[a];
        const v = this._axis(gp, B[id]) > 0.55;
        now[id] = v;
        if (v && !prev[id]) this.pressed.add(id);
      }
      // menu navigation from the pad (independent of bindings)
      const nb = this._nb, bt = gp.buttons;
      const btn = (i) => !!(bt[i] && bt[i].value > 0.5);
      nb.confirm = btn(0); nb.back = btn(1); nb.tabPrev = btn(4); nb.tabNext = btn(5);
      nb.up = btn(12); nb.down = btn(13); nb.left = btn(14); nb.right = btn(15); nb.start = btn(9);
      for (let a = 0; a < NAV_KEYS.length; a++) {
        const k = NAV_KEYS[a], key = NAV_PREV[a];
        if (nb[k] && !prev[key]) this.nav.push({ type: k, device: 'pad' });
        now[key] = nb[k];
      }
      // directional with repeat (d-pad or left stick)
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const dir = nb.up || ay < -0.6 ? 'up' : nb.down || ay > 0.6 ? 'down' : nb.left || ax < -0.6 ? 'left' : nb.right || ax > 0.6 ? 'right' : null;
      const R = this.navRepeat;
      if (dir) {
        if (R.dir !== dir) { this.nav.push({ type: dir, device: 'pad' }); R.dir = dir; R.t = 0.38; }
        else { R.t -= dt; if (R.t <= 0) { this.nav.push({ type: dir, device: 'pad', repeat: true }); R.t = 0.11; } }
      } else R.dir = null;
      let active = Math.abs(ax) > 0.4 || Math.abs(ay) > 0.4 || tgt.throttle > 0.05 || tgt.front > 0.05 || Math.abs(cx) > 0.3;
      if (!active) for (const k in nb) if (nb[k]) { active = true; break; }
      if (active) this.lastDevice = 'pad';
    }

    _padCapture(gp, dt) {
      const c = this.capture;
      c.t += dt;
      if (!c.base) c.base = { b: gp.buttons.map((x) => x.value), a: gp.axes.slice() };
      if (c.t < 0.25) return; // let the press that opened the dialog settle
      for (let i = 0; i < gp.buttons.length; i++) {
        if (gp.buttons[i].value > 0.6 && (c.base.b[i] || 0) < 0.3) { this.capture = null; c.cb({ t: 'b', i }); return; }
      }
      for (let i = 0; i < gp.axes.length; i++) {
        const d = gp.axes[i] - (c.base.a[i] || 0);
        if (Math.abs(d) > 0.6) {
          this.capture = null;
          if ((c.base.a[i] || 0) < -0.8) c.cb({ t: 'a', i, rest: -1 });
          else c.cb({ t: 'a', i, dir: Math.sign(d) });
          return;
        }
      }
      // keep the pad "quiet" while capturing
      for (const k of Object.keys(this.padState)) this.padState[k] = 0;
    }

    consumePressed(id) { if (this.pressed.has(id)) { this.pressed.delete(id); return true; } return false; }
    endFrame() { this.pressed.clear(); this.nav.length = 0; this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0; }

    rumble(strong, weak, ms) {
      if (!this.settings.controller.vibration) return;
      const gp = this._gp();
      try {
        if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
          gp.vibrationActuator.playEffect('dual-rumble', { duration: ms || 120, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) });
        }
      } catch (e) { /* not supported */ }
    }
  }

  MX.Input = Input;
});
