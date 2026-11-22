// Input aggregation: keyboard and controller (both fully rebindable, see settings.js) plus
// mouse. Keyboard keys get analog-style smoothing; controller sticks/triggers are analog.
// Bike and rider are separate: steer = bike, rider lean X/Y = the rider's body.
import { GamepadManager } from './controller.js';
import { clamp, approach } from './util.js';

const _parsed = new Map();
/** Parse a controller binding code once: { k: 'b'|'a'|'t', i, s }. */
function parseCode(code) {
  let p = _parsed.get(code);
  if (p) return p;
  let m = /^b(\d+)$/.exec(code);
  if (m) p = { k: 'b', i: +m[1], s: 1 };
  else if ((m = /^a(\d+)(t?)([+-])$/.exec(code))) p = { k: m[2] ? 't' : 'a', i: +m[1], s: m[3] === '+' ? 1 : -1 };
  else p = { k: '', i: 0, s: 1 };
  _parsed.set(code, p);
  return p;
}

export class Input {
  constructor(settings) {
    this.settings = settings;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.pad = new GamepadManager();
    this.state = {
      throttle: 0, brakeF: 0, brakeR: 0, steer: 0, lean: 0, side: 0, lookBack: false,
      shiftUp: false, shiftDown: false, reset: false, resetHold: 0, camera: false, pause: false, marker: false,
    };
    this.kb = { throttle: 0, brakeF: 0, brakeR: 0, steer: 0, lean: 0, side: 0 };
    this._orbit = { dx: 0, dy: 0 };
    this.mouse = { dx: 0, dy: 0, wheel: 0, dragging: false, lastX: 0, lastY: 0 };
    this.lastDevice = 'keyboard';
    this.captureCallback = null; // used by key rebinding UI
    this.enabled = true;
  }

  attach(target, canvas) {
    target.addEventListener('keydown', (e) => {
      if (this.pad.capture && e.code === 'Escape') {
        e.preventDefault();
        this.pad.cancelCapture();
        return;
      }
      if (this.captureCallback) {
        e.preventDefault();
        const cb = this.captureCallback;
        this.captureCallback = null;
        cb(e.code);
        return;
      }
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' && e.target.type === 'text') return;
      if (!e.repeat) this.pressedKeys.add(e.code);
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      // keep the page from scrolling / buttons from activating while riding
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code) && this.blockDefaults) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    target.addEventListener('blur', () => {
      this.keys.clear();
    });
    if (canvas) {
      canvas.addEventListener('pointerdown', (e) => {
        this.mouse.dragging = true;
        this.mouse.lastX = e.clientX;
        this.mouse.lastY = e.clientY;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!this.mouse.dragging) return;
        this.mouse.dx += e.clientX - this.mouse.lastX;
        this.mouse.dy += e.clientY - this.mouse.lastY;
        this.mouse.lastX = e.clientX;
        this.mouse.lastY = e.clientY;
      });
      const up = (e) => {
        this.mouse.dragging = false;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      };
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('wheel', (e) => {
        this.mouse.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      }, { passive: false });
    }
  }

  bound(action) {
    return this.settings.controls.keys[action] || [];
  }

  down(action) {
    const b = this.bound(action);
    for (let i = 0; i < b.length; i++) if (b[i] && this.keys.has(b[i])) return true;
    return false;
  }

  pressed(action) {
    const b = this.bound(action);
    for (let i = 0; i < b.length; i++) if (b[i] && this.pressedKeys.has(b[i])) return true;
    return false;
  }

  keyPressed(code) {
    return this.pressedKeys.has(code);
  }

  // --- controller bindings -------------------------------------------------------
  /** Value 0..1 of one controller binding code (this frame, or the previous one). */
  padCode(code, prev = false) {
    if (!code) return 0;
    const p = parseCode(code);
    const pad = this.pad;
    if (p.k === 'b') return (prev ? pad.prevButtons[p.i] : pad.buttons[p.i]) || 0;
    const v = (prev ? pad.prevAxes[p.i] : pad.axes[p.i]) || 0;
    if (p.k === 't') return clamp(p.s > 0 ? (v + 1) / 2 : (1 - v) / 2, 0, 1);
    const dz = this.settings.controls.padDeadzone;
    const x = v * p.s;
    return x <= dz ? 0 : Math.min(1, (x - dz) / (1 - dz));
  }

  /** Analog value 0..1 of a riding action from the controller. */
  padAction(action, prev = false) {
    const b = this.settings.controls.pad[action];
    if (!b) return 0;
    let v = 0;
    for (let i = 0; i < b.length; i++) if (b[i]) v = Math.max(v, this.padCode(b[i], prev));
    return v;
  }

  padDown(action) {
    return this.padAction(action) > 0.5;
  }

  padPressed(action) {
    return this.padAction(action) > 0.5 && this.padAction(action, true) <= 0.5;
  }

  /** Call once per frame. Produces smoothed riding inputs. */
  update(dt) {
    const s = this.state;
    const pad = this.pad;
    const hasPad = pad.poll() && !pad.capture;
    const kb = this.kb;
    // --- keyboard analog emulation
    const thr = this.down('throttle') ? 1 : 0;
    kb.throttle = approach(kb.throttle, thr, dt * (thr > kb.throttle ? 3.6 : 8));
    const bf = this.down('brakeFront') ? 1 : 0;
    kb.brakeF = approach(kb.brakeF, bf, dt * (bf > kb.brakeF ? 5 : 10));
    const br = this.down('brakeRear') ? 1 : 0;
    kb.brakeR = approach(kb.brakeR, br, dt * (br > kb.brakeR ? 6 : 10));
    const st = (this.down('steerRight') ? 1 : 0) - (this.down('steerLeft') ? 1 : 0);
    const rate = st === 0 ? 5.5 : Math.sign(st) !== Math.sign(kb.steer) && kb.steer !== 0 ? 7 : 3.4;
    kb.steer = approach(kb.steer, st, dt * rate);
    const ln = (this.down('leanForward') ? 1 : 0) - (this.down('leanBack') ? 1 : 0);
    kb.lean = approach(kb.lean, ln, dt * 4.5);
    const sd = (this.down('riderRight') ? 1 : 0) - (this.down('riderLeft') ? 1 : 0);
    kb.side = approach(kb.side, sd, dt * 4.5);
    let throttle = kb.throttle, brakeF = kb.brakeF, brakeR = kb.brakeR, steer = kb.steer, lean = kb.lean, side = kb.side;
    let lookBack = this.down('lookBack');
    let shiftUp = this.pressed('shiftUp'), shiftDown = this.pressed('shiftDown');
    let reset = this.pressed('reset');
    let camera = this.pressed('camera');
    let pause = this.keyPressed('Escape');
    let resetHeld = this.down('reset');
    let marker = this.down('marker');
    // --- controller (every action goes through the user's bindings)
    if (hasPad) {
      const c = this.settings.controls;
      const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.35);
      const padSteer = clamp(curve(this.padAction('steerRight') - this.padAction('steerLeft')) * c.padSteerSens, -1, 1);
      const padSide = clamp(this.padAction('riderRight') - this.padAction('riderLeft'), -1, 1);
      const padLean = clamp((this.padAction('leanForward') - this.padAction('leanBack')) * (c.invertLean ? -1 : 1), -1, 1);
      const pThr = this.padAction('throttle'), pBf = this.padAction('brakeFront'), pBr = this.padAction('brakeRear');
      if (pad.active(Math.max(0.3, c.padDeadzone))) this.lastDevice = 'gamepad';
      if (Math.abs(padSteer) > Math.abs(steer)) steer = padSteer;
      if (Math.abs(padLean) > Math.abs(lean)) lean = padLean;
      if (Math.abs(padSide) > Math.abs(side)) side = padSide;
      throttle = Math.max(throttle, pThr);
      brakeF = Math.max(brakeF, pBf);
      brakeR = Math.max(brakeR, pBr, c.linkedBrakes ? pBf * 0.55 : 0);
      lookBack = lookBack || this.padDown('lookBack');
      shiftUp = shiftUp || this.padPressed('shiftUp');
      shiftDown = shiftDown || this.padPressed('shiftDown');
      camera = camera || this.padPressed('camera');
      pause = pause || this.padPressed('pause');
      reset = reset || this.padPressed('reset');
      resetHeld = resetHeld || this.padDown('reset');
      marker = marker || this.padDown('marker');
    }
    s.throttle = clamp(throttle, 0, 1);
    s.brakeF = clamp(brakeF, 0, 1);
    s.brakeR = clamp(brakeR, 0, 1);
    s.steer = clamp(steer, -1, 1);
    s.lean = clamp(lean, -1, 1);
    s.side = clamp(side, -1, 1);
    s.lookBack = lookBack;
    s.shiftUp = shiftUp;
    s.shiftDown = shiftDown;
    s.reset = reset;
    s.resetHold = resetHeld ? s.resetHold + dt : 0;
    s.camera = camera;
    s.pause = pause;
    s.marker = marker;
    return s;
  }

  /**
   * Camera orbit (radians this frame) from mouse drag plus either the camera bindings
   * (riding) or the right stick (menus / garage, where the d-pad navigates).
   */
  orbit(dt, menu = false) {
    const m = this.mouse;
    const o = this._orbit;
    o.dx = m.dx * 0.005;
    o.dy = m.dy * 0.005;
    m.dx = 0;
    m.dy = 0;
    const kx = (this.down('camRight') ? 1 : 0) - (this.down('camLeft') ? 1 : 0);
    const ky = (this.down('camDown') ? 1 : 0) - (this.down('camUp') ? 1 : 0);
    o.dx += kx * dt * 2.2;
    o.dy += ky * dt * 1.6;
    if (this.pad.connected && !this.pad.capture) {
      if (menu) {
        o.dx += this.pad.axis(2, 0.15) * dt * 2.6;
        o.dy += this.pad.axis(3, 0.15) * dt * 2.0;
      } else {
        o.dx += (this.padAction('camRight') - this.padAction('camLeft')) * dt * 2.6;
        o.dy += (this.padAction('camDown') - this.padAction('camUp')) * dt * 2.0;
      }
    }
    return o;
  }

  wheel() {
    const w = this.mouse.wheel;
    this.mouse.wheel = 0;
    return w;
  }

  /** Free camera movement keys (IJKL/UO + Shift). */
  freeCam(out = {}) {
    const k = this.keys;
    out.fz = (k.has('KeyI') ? 1 : 0) - (k.has('KeyK') ? 1 : 0);
    out.fx = (k.has('KeyL') ? 1 : 0) - (k.has('KeyJ') ? 1 : 0);
    out.fy = (k.has('KeyO') ? 1 : 0) - (k.has('KeyU') ? 1 : 0);
    out.fast = k.has('ShiftLeft') || k.has('ShiftRight');
    return out;
  }

  endFrame() {
    this.pressedKeys.clear();
  }

  clearRiding() {
    this.keys.clear();
    this.kb.throttle = this.kb.brakeF = this.kb.brakeR = this.kb.steer = this.kb.lean = this.kb.side = 0;
  }
}
