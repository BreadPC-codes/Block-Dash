// Camera rig: chase, close chase, helmet (first person) and free camera, plus a
// cinematic orbit used behind the menus.
import * as THREE from 'three';
import { clamp, damp, wrapAngle } from './util.js';

export const CAMERA_MODES = ['chase', 'close', 'helmet', 'free'];
export const CAMERA_LABELS = { chase: 'Chase cam', close: 'Close chase', helmet: 'Helmet cam', free: 'Free cam' };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _t = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class CameraRig {
  constructor(camera, terrain) {
    this.camera = camera;
    this.terrain = terrain;
    this.mode = 'chase';
    this.yaw = 0;
    this.pitchOff = 0;
    this.yawOff = 0;
    this.orbitIdle = 10;
    this.target = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    this.fov = 64;
    this.free = { pos: new THREE.Vector3(), yaw: 0, pitch: -0.2 };
    this.menuT = 0;
    this.sensitivity = 1;
    this.distanceScale = 1;
    this.snapNext = true;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'free') {
      this.free.pos.copy(this.camera.position);
      _e.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.free.yaw = _e.y;
      this.free.pitch = _e.x;
    }
    this.mode = mode;
    this.snapNext = true;
  }

  next() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  /** Orbit input (mouse drag / right stick), radians. */
  orbit(dx, dy) {
    const s = this.sensitivity;
    if (this.mode === 'free') {
      this.free.yaw -= dx * s;
      this.free.pitch = clamp(this.free.pitch - dy * s, -1.45, 1.45);
      return;
    }
    this.yawOff = wrapAngle(this.yawOff - dx * s);
    this.pitchOff = clamp(this.pitchOff - dy * s, -0.35, 0.9);
    this.orbitIdle = 0;
  }

  /** ctx: { origin, quat, vel, speed, airborne, crashed, focus, eye, lookBack, dt } */
  update(dt, ctx, input) {
    const cam = this.camera;
    const terrain = this.terrain;
    this.orbitIdle += dt;
    if (this.orbitIdle > 1.4 && this.mode !== 'free') {
      this.yawOff = damp(this.yawOff, 0, 2.5, dt);
      this.pitchOff = damp(this.pitchOff, 0, 2.5, dt);
    }
    if (this.mode === 'free') {
      const f = this.free;
      const spd = (input && input.fast ? 40 : 12) * dt;
      const fwd = _v.set(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch));
      const right = _v2.set(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
      if (input) {
        f.pos.addScaledVector(fwd, (input.fz || 0) * spd + (input.wheel || 0) * 2.2);
        f.pos.addScaledVector(right, (input.fx || 0) * spd);
        f.pos.y += (input.fy || 0) * spd;
      }
      const gh = terrain.height(f.pos.x, f.pos.z);
      if (f.pos.y < gh + 0.4) f.pos.y = gh + 0.4;
      cam.position.copy(f.pos);
      _e.set(f.pitch, f.yaw, 0, 'YXZ');
      cam.quaternion.setFromEuler(_e);
      this._setFov(70, dt);
      return;
    }

    // forward direction of the bike projected on the ground
    _v.set(0, 0, 1).applyQuaternion(ctx.quat);
    let heading = Math.atan2(_v.x, _v.z);
    if (ctx.speed > 4 && !ctx.crashed) {
      // blend toward the travel direction to soften whips and slides
      const vh = Math.atan2(ctx.vel.x, ctx.vel.z);
      const w = clamp((ctx.speed - 4) / 10, 0, 0.6);
      heading = heading + wrapAngle(vh - heading) * w;
    }
    if (this.mode === 'helmet' && !ctx.crashed) {
      // eye position from rider head, orientation from bike with reduced roll
      cam.position.copy(ctx.eye);
      _e.setFromQuaternion(ctx.quat, 'YXZ');
      const roll = _e.z * 0.55;
      _e.set(-_e.x * 1.0 + this.pitchOff * 0.6, _e.y + Math.PI + this.yawOff + (ctx.lookBack ? Math.PI : 0), -roll, 'YXZ');
      // camera looks down -Z; bike forward is +Z, so add PI to yaw and flip pitch
      cam.quaternion.setFromEuler(_e);
      this._setFov(84, dt);
      this.snapNext = true;
      return;
    }

    const close = this.mode === 'close';
    const base = (close ? 2.75 : 4.7) * this.distanceScale;
    const dist = base + (close ? 0.4 : 1.4) * clamp(ctx.speed / 30, 0, 1);
    const height = (close ? 1.25 : 1.75) * Math.sqrt(this.distanceScale);
    if (this.snapNext) {
      this.yaw = heading;
      this.target.copy(ctx.focus);
    }
    const yawRate = ctx.crashed ? 0.6 : ctx.airborne ? 2.2 : 4.2;
    this.yaw += wrapAngle(heading - this.yaw) * (1 - Math.exp(-yawRate * dt));
    // target: light smoothing, stronger vertical smoothing
    const tl = 1 - Math.exp(-18 * dt);
    const tv = 1 - Math.exp(-(ctx.airborne ? 7 : 11) * dt);
    this.target.x += (ctx.focus.x - this.target.x) * tl;
    this.target.z += (ctx.focus.z - this.target.z) * tl;
    this.target.y += (ctx.focus.y - this.target.y) * tv;
    let yaw = this.yaw + this.yawOff + (ctx.lookBack ? Math.PI : 0);
    const pitch = 0.08 + this.pitchOff;
    const d = ctx.crashed ? dist * 1.35 : dist;
    const desired = _t.set(
      this.target.x - Math.sin(yaw) * d * Math.cos(pitch),
      this.target.y + height + Math.sin(pitch) * d,
      this.target.z - Math.cos(yaw) * d * Math.cos(pitch)
    );
    // keep above the terrain along the view line
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const px = this.target.x + (desired.x - this.target.x) * t;
      const pz = this.target.z + (desired.z - this.target.z) * t;
      const py = this.target.y + 0.5 + (desired.y - this.target.y - 0.5) * t;
      const gh = terrain.height(px, pz) + 0.55;
      if (py < gh) desired.y += (gh - py) * (t > 0 ? 1 / Math.max(t, 0.35) : 1);
    }
    if (this.snapNext) {
      this.camPos.copy(desired);
      this.snapNext = false;
    } else {
      this.camPos.lerp(desired, 1 - Math.exp(-(ctx.crashed ? 3 : 14) * dt));
    }
    const gh = terrain.height(this.camPos.x, this.camPos.z) + 0.45;
    if (this.camPos.y < gh) this.camPos.y = gh;
    cam.position.copy(this.camPos);
    // look slightly ahead of the rider
    _v2.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.look.copy(this.target).addScaledVector(_v2, ctx.lookBack ? -1.2 : 1.4);
    this.look.y += close ? 0.55 : 0.75;
    cam.lookAt(this.look);
    this._setFov((close ? 68 : 62) + clamp(ctx.speed * 0.28, 0, 11), dt);
  }

  /** Slow cinematic orbit for the menu background. */
  updateMenu(dt, center) {
    this.menuT += dt;
    const a = this.menuT * 0.06;
    const r = 9.5;
    const x = center.x + Math.sin(a) * r, z = center.z + Math.cos(a) * r;
    const gh = this.terrain.height(x, z);
    this.camera.position.set(x, Math.max(gh + 1.2, center.y + 1.6), z);
    _v.copy(center);
    _v.y += 0.6;
    this.camera.lookAt(_v);
    this._setFov(50, 1);
    this.snapNext = true;
  }

  _setFov(f, dt) {
    this.fov = damp(this.fov, f, 4, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
void _m; void _q;
