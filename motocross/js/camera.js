/* =====================================================================
   ROOST MX - camera rig: chase, helmet (first person), trackside side
   camera and a free orbit camera, with smooth blends between them.
   ===================================================================== */
MX.module('camera', function (THREE, MX) {
  'use strict';
  const { clamp, lerp, damp } = MX;
  const V = THREE.Vector3, Q = THREE.Quaternion;
  const MODES = ['chase', 'helmet', 'side', 'free'];
  const NAMES = { chase: 'Chase camera', helmet: 'Helmet camera', side: 'Side camera', free: 'Free camera' };

  class CameraRig {
    constructor(camera) {
      this.camera = camera;
      this.mode = 'chase';
      this.settings = { distance: 1, height: 1, sensitivity: 1, invertX: false, invertY: false, fov: 70 };
      this.pos = new V(); this.look = new V();
      this.vel = new V();
      this.chaseDir = new V(0, 0, 1);
      this.orbitYaw = 0; this.orbitPitch = 0.22; this.freeDist = 6;
      this.lookYaw = 0; this.lookPitch = 0; this.idleT = 9;
      this.blend = 1; this.fromPos = new V(); this.fromQuat = new Q();
      this.shake = 0;
      this.roll = 0;
      this.initialized = false;
    }

    static get modes() { return MODES; }
    modeName() { return NAMES[this.mode]; }

    setMode(m) {
      if (m === this.mode) return;
      this.fromPos.copy(this.camera.position);
      this.fromQuat.copy(this.camera.quaternion);
      this.blend = 0;
      this.mode = m;
      if (m === 'free') { this.orbitYaw = Math.atan2(this.camera.position.x - this.look.x, this.camera.position.z - this.look.z); }
    }
    next() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); return this.mode; }

    // look input in radians/second-ish (mouse delta or stick)
    addLook(dx, dy) {
      const s = this.settings;
      dx *= (s.invertX ? -1 : 1); dy *= (s.invertY ? -1 : 1);
      if (Math.abs(dx) + Math.abs(dy) > 1e-4) this.idleT = 0;
      if (this.mode === 'free') {
        this.orbitYaw -= dx; this.orbitPitch = clamp(this.orbitPitch + dy, -0.15, 1.35);
      } else {
        this.lookYaw = clamp(this.lookYaw - dx, -2.6, 2.6);
        this.lookPitch = clamp(this.lookPitch + dy, -0.6, 0.8);
      }
    }
    zoom(d) { this.freeDist = clamp(this.freeDist * (1 + d), 2.5, 25); this.settings.distance = clamp(this.settings.distance * (1 + d * 0.5), 0.6, 2.2); }
    addShake(a) { this.shake = Math.min(1.2, this.shake + a); }

    snap(phys) { this.initialized = false; this.update(1 / 60, phys, null); }

    update(dt, phys, model) {
      const cam = this.camera, s = this.settings;
      cam.fov = damp(cam.fov, s.fov + (this.mode === 'helmet' ? 6 : 0), 4, dt);
      cam.updateProjectionMatrix();
      this.idleT += dt;
      if (this.idleT > 1.2 && this.mode !== 'free') {
        this.lookYaw = damp(this.lookYaw, 0, 2.2, dt);
        this.lookPitch = damp(this.lookPitch, 0, 2.2, dt);
      }
      const crashed = phys.crashed && phys.crash;
      const focus = _f.copy(crashed ? phys.crash.rider.pos : phys.origin);
      if (!crashed) focus.addScaledVector(phys.u, 0.55);
      // smoothed heading (horizontal velocity, falls back to the bike's forward)
      const hv = _h.set(phys.vel.x, 0, phys.vel.z);
      const fwd = _g.set(phys.f.x, 0, phys.f.z).normalize();
      if (hv.lengthSq() > 4) { hv.normalize(); fwd.lerp(hv, phys.airborne ? 0.7 : 0.35).normalize(); }
      if (!this.initialized) { this.chaseDir.copy(fwd); }
      if (!crashed) {
        const k = 1 - Math.exp(-dt * (phys.airborne ? 1.6 : 3.2));
        this.chaseDir.lerp(fwd, k).normalize();
      }
      let wantPos = _p, wantLook = _l;
      let roll = 0;
      switch (this.mode) {
        case 'chase': {
          const dist = 3.7 * s.distance, height = 1.45 * s.height;
          const dir = _d.copy(this.chaseDir).applyAxisAngle(_up, this.lookYaw);
          wantPos.copy(focus).addScaledVector(dir, -dist * Math.cos(this.lookPitch * 0.6));
          wantPos.y += height + Math.sin(this.lookPitch) * dist * 0.8;
          wantLook.copy(focus).addScaledVector(dir, 2.2);
          wantLook.y += 0.25;
          roll = -phys.lean * 0.12;
          break;
        }
        case 'helmet': {
          if (model && !crashed) {
            const head = _e.copy(model.headLocal);
            head.y += 0.03; head.z += 0.08;
            wantPos.copy(head).sub(phys.com).applyQuaternion(phys.q).add(phys.pos);
            const look = _d.set(0, 0, 1).applyAxisAngle(_x, -0.08 + this.lookPitch * 0.5).applyAxisAngle(_y, this.lookYaw).applyQuaternion(phys.q);
            // keep the horizon steadier than the bike
            look.y = lerp(look.y, 0, 0.35);
            wantLook.copy(wantPos).addScaledVector(look, 10);
            roll = -phys.lean * 0.45;
          } else {
            wantPos.copy(focus).add(_e.set(0, 1.5, 0)); wantLook.copy(focus);
          }
          break;
        }
        case 'side': {
          const side = _d.crossVectors(this.chaseDir, _up).normalize();
          const dist = 7 * s.distance;
          wantPos.copy(focus).addScaledVector(side, dist).addScaledVector(this.chaseDir, 1.8);
          wantPos.y += 1.1 * s.height;
          wantLook.copy(focus).addScaledVector(this.chaseDir, 0.8);
          break;
        }
        case 'free': {
          const d = this.freeDist;
          wantPos.set(focus.x + Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * d, focus.y + Math.sin(this.orbitPitch) * d + 0.3, focus.z + Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * d);
          wantLook.copy(focus);
          break;
        }
      }
      if (crashed && this.mode !== 'free') {
        // slow orbit around the crash
        const a = phys.crash.t * 0.35;
        wantPos.set(focus.x + Math.sin(a) * 6, focus.y + 2.6, focus.z + Math.cos(a) * 6);
        wantLook.copy(focus);
      }
      // keep the camera above the ground
      if (this.track) {
        const gh = this.track.height(wantPos.x, wantPos.z) + (this.mode === 'helmet' ? 0.2 : 0.45);
        if (wantPos.y < gh) wantPos.y = gh;
      }
      if (!this.initialized) { this.pos.copy(wantPos); this.look.copy(wantLook); this.initialized = true; }
      if (this.mode === 'helmet' && !crashed) {
        this.pos.copy(wantPos); this.look.lerp(wantLook, 1 - Math.exp(-dt * 25));
      } else {
        // spring-ish follow: horizontal tight, vertical lazier (jumps read better)
        const kh = 1 - Math.exp(-dt * (this.mode === 'side' ? 3 : 7));
        const kv = 1 - Math.exp(-dt * (phys.airborne ? 2.2 : 5));
        this.pos.x = lerp(this.pos.x, wantPos.x, kh); this.pos.z = lerp(this.pos.z, wantPos.z, kh);
        this.pos.y = lerp(this.pos.y, wantPos.y, kv);
        this.look.lerp(wantLook, 1 - Math.exp(-dt * 12));
      }
      this.roll = damp(this.roll, roll, 6, dt);
      cam.position.copy(this.pos);
      // shake
      if (this.shake > 0.001) {
        const a = this.shake * 0.06;
        cam.position.x += (Math.random() - 0.5) * a; cam.position.y += (Math.random() - 0.5) * a; cam.position.z += (Math.random() - 0.5) * a;
        this.shake = Math.max(0, this.shake - dt * 2.5);
      }
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      if (Math.abs(this.roll) > 1e-4) cam.rotateZ(this.roll);
      // blend from the previous mode
      if (this.blend < 1) {
        this.blend = Math.min(1, this.blend + dt / 0.55);
        const t = this.blend * this.blend * (3 - 2 * this.blend);
        _bq.copy(cam.quaternion);
        cam.position.lerpVectors(this.fromPos, cam.position, t);
        cam.quaternion.slerpQuaternions(this.fromQuat, _bq, t);
      }
    }
  }
  const _f = new V(), _h = new V(), _g = new V(), _p = new V(), _l = new V(), _d = new V(), _e = new V();
  const _up = new V(0, 1, 0), _x = new V(1, 0, 0), _y = new V(0, 1, 0);
  const _bq = new Q();

  MX.CameraRig = CameraRig;
});
