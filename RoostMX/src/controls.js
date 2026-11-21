// Input aggregation: keyboard (rebindable, with analog-style smoothing) + gamepad + mouse.
import { GamepadManager, PAD } from './controller.js';
import { clamp, approach } from './util.js';

export class Input {
  constructor(settings) {
    this.settings = settings;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.pad = new GamepadManager();
    this.state = {
      throttle: 0, brakeF: 0, brakeR: 0, steer: 0, lean: 0, lookBack: false,
      shiftUp: false, shiftDown: false, reset: false, resetHold: 0, camera: false, pause: false,
    };
    this.kb = { throttle: 0, brakeF: 0, brakeR: 0, steer: 0, lean: 0 };
    this.mouse = { dx: 0, dy: 0, wheel: 0, dragging: false, lastX: 0, lastY: 0 };
    this.lastDevice = 'keyboard';
    this.captureCallback = null; // used by key rebinding UI
    this.enabled = true;
  }

  attach(target, canvas) {
    target.addEventListener('keydown', (e) => {
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
    for (const k of this.bound(action)) if (k && this.keys.has(k)) return true;
    return false;
  }

  pressed(action) {
    for (const k of this.bound(action)) if (k && this.pressedKeys.has(k)) return true;
    return false;
  }

  keyPressed(code) {
    return this.pressedKeys.has(code);
  }

  /** Call once per frame. Produces smoothed riding inputs. */
  update(dt) {
    const s = this.state;
    const pad = this.pad;
    const hasPad = pad.poll();
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
    let throttle = kb.throttle, brakeF = kb.brakeF, brakeR = kb.brakeR, steer = kb.steer, lean = kb.lean;
    let lookBack = this.down('lookBack');
    let shiftUp = this.pressed('shiftUp'), shiftDown = this.pressed('shiftDown');
    let reset = this.pressed('reset');
    let camera = this.pressed('camera');
    let pause = this.keyPressed('Escape');
    let resetHeld = this.down('reset');
    // --- gamepad
    if (hasPad) {
      const c = this.settings.controls;
      const dz = c.padDeadzone;
      const sx = pad.axis(0, dz);
      const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.35);
      const padSteer = clamp(curve(sx) * c.padSteerSens, -1, 1);
      const padLean = clamp(-pad.axis(1, dz) * (c.invertLean ? -1 : 1), -1, 1);
      const rt = pad.value(PAD.RT), lt = pad.value(PAD.LT);
      const xRear = pad.value(PAD.X);
      const any = Math.abs(padSteer) > 0 || Math.abs(padLean) > 0 || rt > 0.02 || lt > 0.02 || pad.buttons.some((b) => b > 0.5);
      if (any) this.lastDevice = 'gamepad';
      if (Math.abs(padSteer) > Math.abs(steer)) steer = padSteer;
      if (Math.abs(padLean) > Math.abs(lean)) lean = padLean;
      throttle = Math.max(throttle, rt);
      brakeF = Math.max(brakeF, lt);
      brakeR = Math.max(brakeR, lt * 0.55, xRear);
      lookBack = lookBack || pad.down(PAD.B);
      shiftUp = shiftUp || pad.pressed(PAD.RB);
      shiftDown = shiftDown || pad.pressed(PAD.LB);
      camera = camera || pad.pressed(PAD.Y);
      pause = pause || pad.pressed(PAD.START);
      reset = reset || pad.pressed(PAD.A) || pad.pressed(PAD.VIEW);
      resetHeld = resetHeld || pad.down(PAD.A);
    }
    s.throttle = clamp(throttle, 0, 1);
    s.brakeF = clamp(brakeF, 0, 1);
    s.brakeR = clamp(brakeR, 0, 1);
    s.steer = clamp(steer, -1, 1);
    s.lean = clamp(lean, -1, 1);
    s.lookBack = lookBack;
    s.shiftUp = shiftUp;
    s.shiftDown = shiftDown;
    s.reset = reset;
    s.resetHold = resetHeld ? s.resetHold + dt : 0;
    s.camera = camera;
    s.pause = pause;
    return s;
  }

  /** Camera orbit from mouse drag and right stick (radians this frame). */
  orbit(dt) {
    const m = this.mouse;
    let dx = m.dx * 0.005, dy = m.dy * 0.005;
    m.dx = 0;
    m.dy = 0;
    if (this.pad.connected) {
      dx += this.pad.axis(2, 0.15) * dt * 2.6;
      dy += this.pad.axis(3, 0.15) * dt * 2.0;
    }
    return { dx, dy };
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
    this.kb.throttle = this.kb.brakeF = this.kb.brakeR = this.kb.steer = this.kb.lean = 0;
  }
}
