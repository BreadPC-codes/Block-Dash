// Gamepad support via the browser Gamepad API (Xbox-style "standard" mapping and generic pads).

export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, HOME: 16,
};

export class GamepadManager {
  constructor() {
    this.index = -1;
    this.id = '';
    this.prevButtons = [];
    this.buttons = [];
    this.axes = [0, 0, 0, 0];
    this.connected = false;
    this.listeners = { connect: [], disconnect: [] };
    this.navRepeat = { dir: '', t: 0 };
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
      this.connected = true;
      this.listeners.connect.forEach((f) => f(gp));
    }
  }

  _onDisconnect(gp) {
    if (gp.index === this.index) {
      this.index = -1;
      this.connected = false;
      this.buttons = [];
      this.prevButtons = [];
      this.listeners.disconnect.forEach((f) => f(gp));
      // fall back to another connected pad, if any
      const pads = this._pads();
      for (const p of pads) if (p) { this._onConnect(p); break; }
    }
  }

  _pads() {
    try {
      return navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    } catch (e) {
      return [];
    }
  }

  poll() {
    this.prevButtons = this.buttons;
    const pads = this._pads();
    let gp = this.index >= 0 ? pads[this.index] : null;
    if (!gp) {
      // some browsers only expose pads after a button press, without an event
      for (const p of pads) if (p && p.connected) { this._onConnect(p); gp = p; break; }
    }
    if (!gp) {
      this.buttons = [];
      this.axes = [0, 0, 0, 0];
      return false;
    }
    this.buttons = gp.buttons.map((b) => (typeof b === 'object' ? b.value : b));
    this.axes = [gp.axes[0] || 0, gp.axes[1] || 0, gp.axes[2] || 0, gp.axes[3] || 0];
    // generic (non-standard) pads often report triggers on axes 4/5 or 2/5
    if (gp.mapping !== 'standard' && gp.axes.length >= 6 && this.buttons[PAD.RT] === undefined) {
      this.buttons[PAD.LT] = (gp.axes[4] + 1) / 2;
      this.buttons[PAD.RT] = (gp.axes[5] + 1) / 2;
    }
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

  /** Menu navigation from d-pad / left stick with key-repeat. Returns '', 'up', 'down', 'left', 'right'. */
  nav(dt) {
    let dir = '';
    if (this.down(PAD.UP) || this.axes[1] < -0.6) dir = 'up';
    else if (this.down(PAD.DOWN) || this.axes[1] > 0.6) dir = 'down';
    else if (this.down(PAD.LEFT) || this.axes[0] < -0.6) dir = 'left';
    else if (this.down(PAD.RIGHT) || this.axes[0] > 0.6) dir = 'right';
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
