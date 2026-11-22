// Gamepad support via the browser Gamepad API (Xbox-style "standard" mapping and generic
// pads). Polling reuses its arrays (no per-frame garbage). Riding actions are bound
// through settings.controls.pad (see settings.js / controls.js); menu navigation uses the
// fixed layout below.

export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16,
};

export class GamepadManager {
  constructor() {
    this.index = -1;
    this.id = '';
    this.standard = true;
    this.prevButtons = [];
    this.buttons = [];
    this.axes = [0, 0, 0, 0];
    this.prevAxes = [0, 0, 0, 0];
    this.connected = false;
    this.listeners = { connect: [], disconnect: [] };
    this.navRepeat = { dir: '', t: 0 };
    this.capture = null; // { cb, phase, baseAxes, t }
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', (e) => this._onConnect(e.gamepad));
      window.addEventListener('gamepaddisconnected', (e) => this._onDisconnect(e.gamepad));
    }
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }

  _onConnect(gp) {
    if (this.index === -1) {
      this.index = gp.index;
      this.id = gp.id;
      this.standard = gp.mapping === 'standard';
      this.connected = true;
      this.listeners.connect.forEach((f) => f(gp));
    }
  }

  _onDisconnect(gp) {
    if (gp.index === this.index) {
      this.index = -1;
      this.connected = false;
      this.buttons.length = 0;
      this.prevButtons.length = 0;
      this.listeners.disconnect.forEach((f) => f(gp));
      // fall back to another connected pad, if any
      const pads = this._pads();
      for (let i = 0; i < pads.length; i++) if (pads[i]) { this._onConnect(pads[i]); break; }
    }
  }

  _pads() {
    try {
      return (navigator.getGamepads && navigator.getGamepads()) || [];
    } catch (e) {
      return [];
    }
  }

  poll() {
    // swap buffers instead of allocating new arrays every frame
    const pb = this.prevButtons;
    this.prevButtons = this.buttons;
    this.buttons = pb;
    const pa = this.prevAxes;
    this.prevAxes = this.axes;
    this.axes = pa;
    const pads = this._pads();
    let gp = this.index >= 0 ? pads[this.index] : null;
    if (!gp) {
      // some browsers only expose pads after a button press, without an event
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected) { this._onConnect(p); gp = p; break; }
      }
    }
    if (!gp) {
      this.buttons.length = 0;
      for (let i = 0; i < this.axes.length; i++) this.axes[i] = 0;
      return false;
    }
    const B = gp.buttons, nb = B.length;
    this.buttons.length = nb;
    for (let i = 0; i < nb; i++) {
      const b = B[i];
      this.buttons[i] = typeof b === 'object' ? b.value || (b.pressed ? 1 : 0) : b;
    }
    const A = gp.axes, na = Math.max(4, A.length);
    this.axes.length = na;
    for (let i = 0; i < na; i++) this.axes[i] = A[i] || 0;
    this.standard = gp.mapping === 'standard';
    // generic (non-standard) pads often report triggers on axes 4/5
    if (!this.standard && A.length >= 6 && this.buttons[PAD.RT] === undefined) {
      this.buttons[PAD.LT] = (A[4] + 1) / 2;
      this.buttons[PAD.RT] = (A[5] + 1) / 2;
    }
    if (this.capture) this._updateCapture();
    return true;
  }

  value(b) {
    return this.buttons[b] || 0;
  }

  down(b) {
    return (this.buttons[b] || 0) > 0.5;
  }

  pressed(b) {
    return (this.buttons[b] || 0) > 0.5 && !((this.prevButtons[b] || 0) > 0.5);
  }

  axis(i, deadzone = 0.12) {
    const v = this.axes[i] || 0;
    const a = Math.abs(v);
    if (a < deadzone) return 0;
    return Math.sign(v) * ((a - deadzone) / (1 - deadzone));
  }

  /** Anything pressed or pushed? (used to detect the active device) */
  active(deadzone = 0.3) {
    for (let i = 0; i < this.buttons.length; i++) if (this.buttons[i] > 0.5) return true;
    for (let i = 0; i < 4; i++) if (Math.abs(this.axes[i]) > deadzone) return true;
    return false;
  }

  /**
   * Wait for the next button press or stick/trigger movement and report it as a binding
   * code ('b<i>', 'a<i>+', 'a<i>-', 'a<i>t+'). Inputs held when capture starts are ignored
   * until released. cb(null) on timeout / cancel.
   */
  captureNext(cb, timeout = 8) {
    this.capture = { cb, phase: 'release', base: this.axes.slice(), t: performance.now(), timeout: timeout * 1000 };
  }

  cancelCapture() {
    const c = this.capture;
    this.capture = null;
    if (c) c.cb(null);
  }

  _updateCapture() {
    const c = this.capture;
    if (performance.now() - c.t > c.timeout) return this.cancelCapture();
    const B = this.buttons, A = this.axes;
    if (c.phase === 'release') {
      // everything back to rest first (e.g. the A press that opened the capture)
      let held = false;
      for (let i = 0; i < B.length; i++) if (B[i] > 0.3) held = true;
      // sticks must be centred (axes resting near +-1 are triggers and are ignored here)
      for (let i = 0; i < A.length; i++) if (Math.abs(c.base[i] || 0) < 0.7 && Math.abs(A[i]) > 0.3) held = true;
      if (!held) {
        c.phase = 'listen';
        c.base = A.slice();
      }
      return;
    }
    for (let i = 0; i < B.length; i++) {
      // non-standard pads: buttons 6/7 may be synthesised from axes; prefer the axis below
      if (B[i] > 0.6) return this._finishCapture('b' + i);
    }
    let best = -1, bestD = 0.6;
    for (let i = 0; i < A.length; i++) {
      const d = Math.abs(A[i] - (c.base[i] || 0));
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      const v = A[best], b0 = c.base[best] || 0;
      // an axis resting near -1/+1 is a trigger: use its full travel
      if (Math.abs(b0) > 0.7) return this._finishCapture('a' + best + 't' + (v > b0 ? '+' : '-'));
      return this._finishCapture('a' + best + (v > 0 ? '+' : '-'));
    }
  }

  _finishCapture(code) {
    const c = this.capture;
    this.capture = null;
    // swallow this frame's input so the press does not also act in the menu
    for (let i = 0; i < this.buttons.length; i++) this.prevButtons[i] = this.buttons[i];
    this.navBlock = true;
    c.cb(code);
  }

  /** Menu navigation from d-pad / left stick with key-repeat. Returns '', 'up', 'down', 'left', 'right'. */
  nav(dt) {
    let dir = '';
    if (this.down(PAD.UP) || this.axes[1] < -0.6) dir = 'up';
    else if (this.down(PAD.DOWN) || this.axes[1] > 0.6) dir = 'down';
    else if (this.down(PAD.LEFT) || this.axes[0] < -0.6) dir = 'left';
    else if (this.down(PAD.RIGHT) || this.axes[0] > 0.6) dir = 'right';
    if (this.navBlock) {
      // after binding a stick/button, wait until it is released before navigating again
      if (!dir) this.navBlock = false;
      return '';
    }
    const r = this.navRepeat;
    if (!dir) {
      r.dir = '';
      return '';
    }
    if (dir !== r.dir) {
      r.dir = dir;
      r.t = 0.38;
      return dir;
    }
    r.t -= dt;
    if (r.t <= 0) {
      r.t = 0.11;
      return dir;
    }
    return '';
  }

  rumble(strong, weak, ms) {
    try {
      const gp = this._pads()[this.index];
      if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
        gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak });
      }
    } catch (e) {
      /* ignore */
    }
  }
}
