/* =====================================================================
   ROOST MX - game: boot, menus <-> riding, main loop, laps, crashes.
   ===================================================================== */
MX.module('game', function (THREE, MX) {
  'use strict';
  const { clamp } = MX;
  const $ = (id) => document.getElementById(id);
  const DT = MX.BikePhysics.DT;
  const MAX_STEPS = 24;

  class Game {
    constructor() {
      MX.state = this;
      this.settings = MX.loadSettings();
      this.garage = MX.loadGarage();
      this.records = MX.loadRecords();
      this.state = 'boot';
      this.inGame = false;
      this.tracks = {};
      this.input = new MX.Input(this.settings);
      this.audio = new MX.Audio(this.settings);
      this.lap = this._freshLap();
      this.autoResetIn = 0;
      this.physSteps = 0;
    }

    // ------------------------------------------------------------ boot
    init() {
      const q = this.quality();
      const r = this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias, powerPreference: 'high-performance', stencil: false });
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.0;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      $('stage').appendChild(r.domElement);
      this.input.attachCanvas(r.domElement);
      this.menuCam = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
      this.menuCam.position.set(4, 1.6, 5);
      this.gameCam = new THREE.PerspectiveCamera(this.settings.graphics.fov, 1, 0.08, 2600);
      this.rig = new MX.CameraRig(this.gameCam);
      this.showroom = new MX.Showroom();
      this.showroomBike();
      this.hud = new MX.HUD();
      this.ui = new MX.UI(this);
      this._resize();
      window.addEventListener('resize', () => this._resize());
      // menu bike drag
      let dragging = false, lx = 0, vx = 0;
      r.domElement.addEventListener('pointerdown', (e) => { if (!this.inGame) { dragging = true; lx = e.clientX; this.showroom.dragging = true; } });
      window.addEventListener('pointermove', (e) => { if (dragging) { const dx = e.clientX - lx; lx = e.clientX; this.showroom.spin += dx * 0.008; vx = dx * 0.5; } });
      window.addEventListener('pointerup', () => { if (dragging) { dragging = false; this.showroom.dragging = false; this.showroom.spinVel = clamp(vx, -4, 4); } });
      MX.on('pad', (e) => {
        const name = e.kind === 'ps' ? 'PlayStation controller' : e.kind === 'xbox' ? 'Xbox controller' : 'Controller';
        MX.toast(`${name} ${e.type === 'connected' ? 'connected' : 'disconnected'}`, e.type === 'connected' ? 'good' : 'bad');
        if (this.ui) { this.ui.updatePadStatus(); if (this.ui.current === 'settings' || this.ui.current === 'controls') this.ui['render_' + this.ui.current](); }
        if (e.type === 'disconnected' && this.state === 'playing') this.pause();
      });
      document.addEventListener('visibilitychange', () => { if (document.hidden && this.state === 'playing') this.pause(); });
      this.applySettings();
      $('loading').classList.add('hidden');
      document.body.dataset.state = 'splash';
      this.state = 'splash';
      $('splash').classList.remove('hidden');
      const go = () => {
        if (this.state !== 'splash') return;
        this.audio.unlock();
        this.audio.startMusic();
        $('splash').classList.add('hidden');
        this.input.nav.length = 0;          // the key that left the splash must not click PLAY
        this.navLockUntil = performance.now() + 350;
        this.toMenu();
      };
      $('splash').addEventListener('click', go);
      window.addEventListener('keydown', (e) => { if (this.state === 'splash' && !e.repeat) go(); });
      this._goSplash = go;
      this.last = performance.now();
      requestAnimationFrame((t) => this._frame(t));
    }

    quality() { return MX.QUALITY[this.settings.graphics.quality] || MX.QUALITY.high; }

    _resize() {
      const w = window.innerWidth, h = window.innerHeight;
      const q = this.quality();
      const pr = Math.min(window.devicePixelRatio || 1, q.pixelRatio) * this.settings.graphics.resScale;
      this.renderer.setPixelRatio(Math.max(0.35, pr));
      this.renderer.setSize(w, h, false);
      for (const c of [this.menuCam, this.gameCam]) { c.aspect = w / h; c.updateProjectionMatrix(); }
      if (this.fx) this.fx.setViewport(h * this.renderer.getPixelRatio());
    }

    trackCache(id) {
      if (!this.tracks[id]) this.tracks[id] = new MX.Track(MX.trackById(id));
      return this.tracks[id];
    }

    // ------------------------------------------------------------ menus
    showroomBike() {
      const spec = MX.bikeById(this.garage.bike);
      if (this.menuBike) { this.menuBike.dispose(); }
      this.menuBike = new MX.BikeModel(spec, MX.lookFor(this.garage, spec.id), { rider: false, shadows: true });
      this.showroom.setBike(this.menuBike);
      this.showroom.setAccent(MX.lookFor(this.garage, spec.id).plastics);
    }
    refreshLook() {
      const look = MX.lookFor(this.garage, this.garage.bike);
      if (this.menuBike) this.menuBike.setLook(look);
      if (this.model && this.spec && this.spec.id === this.garage.bike) this.model.setLook(look);
      this.showroom.setAccent(look.plastics);
    }
    refreshSetup() {
      if (this.phys) this.phys.setSpec(MX.bikeById(this.garage.bike), MX.setupFor(this.garage, this.garage.bike));
    }

    onScreen(id) {
      const sr = this.showroom;
      sr.mode = id === 'garage' ? 'garage' : id === 'bikes' ? 'bikes' : 'menu';
      if (this.menuBike) this.menuBike.setRiderVisible(id === 'garage');
      if (id === 'garage' && this.menuBike) this.menuBike.update({ sF: 0.07, sR: 0.1, steer: 0.15, wheelF: 0, wheelR: 0, rider: { x: 0, y: 0.78, z: 0.02, seated: 0, legOut: 0 }, lean: 0 });
    }

    toMenu() {
      this.inGame = false;
      this.state = 'menu';
      document.body.dataset.state = 'menu';
      this.hud.show(false);
      this.ui.show('menu');
      if (!this.music) { this.audio.startMusic(); }
      this.audio.duckMusic(1);
    }

    action(a) {
      switch (a) {
        case 'play': this.startRace(); break;
        case 'resume': this.resume(); break;
        case 'restart': this.restart(); break;
        case 'change-track': this.ui.show('tracks', true); break;
        case 'pause-settings': this.ui.show('settings', true); break;
        case 'quit': this.quitToMenu(); break;
      }
    }

    applySettings(path) {
      const S = this.settings;
      if (!this.renderer) return;
      if (!path || path.startsWith('graphics')) {
        this._resize();
        this.renderer.shadowMap.enabled = S.graphics.shadows;
        if (this.world && this.world.sun) { this.world.sun.castShadow = S.graphics.shadows && this.quality().shadows; }
        this.renderer.shadowMap.needsUpdate = true;
        // materials must recompile when the shadow map toggles
        if (path === 'graphics.shadows' && this.world) this.world.scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => (m.needsUpdate = true)); } });
      }
      const G = S.gameplay;
      this.rig.settings.distance = G.cameraDistance;
      this.rig.settings.height = G.cameraHeight;
      this.rig.settings.fov = S.graphics.fov;
      if (this.phys) this.phys.setOptions({ autoClutch: G.autoClutch, autoShift: G.autoShift, tractionControl: G.tractionControl, riderAssist: G.riderAssist });
      this.audio.applyVolumes();
      if (path === 'audio.gameMusic' && this.inGame) { if (S.audio.gameMusic) this.audio.startMusic(); else this.audio.stopMusic(); }
      if (path === 'graphics.quality' && this.inGame) MX.toast('Quality changes apply to tree density & meshes on the next track load');
    }

    // ------------------------------------------------------------ riding
    startRace() {
      const tid = this.garage.track, bid = this.garage.bike;
      this.ui.hideAll();
      this.state = 'loading';
      document.body.dataset.state = 'loading';
      $('trackload-text').textContent = 'Building ' + MX.trackById(tid).name + '…';
      $('trackload').classList.remove('hidden');
      setTimeout(() => {
        try { this._build(tid, bid); }
        catch (e) { console.error(e); MX.toast('Could not load the track: ' + e.message, 'bad', 6000); $('trackload').classList.add('hidden'); this.toMenu(); return; }
        $('trackload').classList.add('hidden');
        this._enterRiding();
      }, 60);
    }

    _teardown() {
      if (this.world) { this.world.dispose(); this.world = null; }
      if (this.fx) { this.fx.dispose(); this.fx = null; }
      if (this.model) { this.model.dispose(); this.model = null; }
      this.phys = null;
      this.audio.stopEngine();
    }

    _build(tid, bid) {
      this._teardown();
      const S = this.settings;
      const q = Object.assign({}, this.quality(), { shadows: S.graphics.shadows && this.quality().shadows });
      const track = this.trackCache(tid);
      this.track = track;
      this.world = new MX.World(track, q);
      const spec = MX.bikeById(bid);
      this.spec = spec;
      const G = S.gameplay;
      this.phys = new MX.BikePhysics(track, spec, MX.setupFor(this.garage, bid), { autoClutch: G.autoClutch, autoShift: G.autoShift, tractionControl: G.tractionControl, riderAssist: G.riderAssist });
      this.phys.reset(track.spawnS);
      this.model = new MX.BikeModel(spec, MX.lookFor(this.garage, bid), { rider: true, shadows: q.shadows });
      this.world.scene.add(this.model.root);
      this.fx = new MX.Effects(this.world.scene, track, q);
      this.fx.setViewport(window.innerHeight * this.renderer.getPixelRatio());
      this.rig.track = track;
      this.rig.mode = S.gameplay.defaultCamera || 'chase';
      this.rig.blend = 1;
      this._syncModel(0);
      this.rig.snap(this.phys);
      this.rig.update(0.016, this.phys, this.model);
      this.hud.setBike(spec);
      this.hud.setTrack(track);
      this.lap = this._freshLap();
      this.lastTrackS = track.spawnS;
      this.accum = 0;
      this.renderer.shadowMap.needsUpdate = true;
      // compile shaders up front to avoid a hitch on the first frames
      this.renderer.compile(this.world.scene, this.gameCam);
    }

    _enterRiding() {
      this.inGame = true;
      this.state = 'playing';
      document.body.dataset.state = 'playing';
      this.hud.show(true);
      this.audio.unlock();
      this.audio.startEngine(this.spec);
      if (!this.settings.audio.gameMusic) this.audio.stopMusic(); else this.audio.duckMusic(0.5);
      const S = this.settings;
      const kb = (id) => MX.keyLabel((S.keyboard.bindings[id] || [])[0]);
      MX.toast(`${this.track.name} · ${this.spec.name}`, 'big', 3000);
      MX.toast(this.input.padInfo() ? 'RT throttle · LT front brake · left stick lean & body · RB/LB shift' : `${kb('throttle')} throttle · ${kb('leanLeft')}/${kb('leanRight')} lean · ${kb('front')} front brake · ${kb('rear')} rear brake · ${kb('shiftUp')}/${kb('shiftDown')} shift`, '', 6000);
      this.last = performance.now();
    }

    _freshLap() {
      const best = this.track && this.spec ? this.records[this.track.id + '|' + this.spec.id] : null;
      const cps = [];
      if (this.track) { const L = this.track.length; for (let k = 1; k <= 6; k++) cps.push((this.track.finishS + L * k / 7) % L); }
      return { started: false, running: false, time: 0, lastLap: null, best: best || null, lapCount: 0, cps, nextCp: 0, prevS: null, invalid: false };
    }

    pause() {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      document.body.dataset.state = 'paused';
      this.ui.stack.length = 0;
      this.ui.show('pause');
      this.audio.updateEngine(this.phys, 0, true);
    }
    resume() {
      if (this.state !== 'paused') return;
      this.ui.hideAll();
      this.state = 'playing';
      document.body.dataset.state = 'playing';
      this.last = performance.now();
    }
    restart() {
      this.ui.hideAll();
      this._doReset(this.track.spawnS, true);
      this.lap = this._freshLap();
      this.state = 'playing';
      document.body.dataset.state = 'playing';
      this.last = performance.now();
    }
    quitToMenu() {
      this._teardown();
      this.toMenu();
    }

    resetBike() {
      if (!this.phys) return;
      const t = this.track, q = {};
      const P = this.phys.crashed ? this.phys.crash.rider.pos : this.phys.pos;
      let s = this.lastTrackS;
      if (t.query(P.x, P.z, q)) s = q.s;
      // back up to flat ground away from jumps and berms
      for (let k = 0; k < 60; k++) {
        const i = Math.floor((((s % t.length) + t.length) % t.length) / MX.TRACK_DS);
        if (t.isFlatAt(s) && t.bermH[i] < 0.15 && t.rutD[i] < 0.05) break;
        s -= 2;
      }
      this._doReset(s, false);
      if (this.lap.running) { this.lap.invalid = true; }
      MX.toast('Bike reset', '', 1400);
    }

    _doReset(s, full) {
      const p = this.phys;
      p.reset(((s % this.track.length) + this.track.length) % this.track.length);
      if (this.model.rider.parent !== this.model.root) { this.model.root.add(this.model.rider); this.model.rider.position.set(0, 0, 0); this.model.rider.quaternion.identity(); }
      this.fx.marks.lift(0); this.fx.marks.lift(1);
      if (full) this.fx.clear();
      this.autoResetIn = 0;
      this._syncModel(0);
      this.rig.snap(p);
      this.audio.startEngine(this.spec);
    }

    // ------------------------------------------------------------ frame
    _frame(now) {
      requestAnimationFrame((t) => this._frame(t));
      let dt = (now - this.last) / 1000;
      this.last = now;
      if (!(dt > 0)) dt = 0.016;
      dt = Math.min(dt, 0.1);
      this.input.update(dt);
      // splash: any pad button starts
      if (this.state === 'splash' && this.input.nav.some((n) => n.device === 'pad')) this._goSplash();
      if (this.inGame && (this.state === 'playing' || this.state === 'paused')) this._gameFrame(dt);
      else this._menuFrame(dt);
      this.input.endFrame();
    }

    _menuFrame(dt) {
      if (this.ui && this.ui.current) {
        if (!(this.navLockUntil > performance.now())) this.ui.handleNav(this.input.nav);
        this.ui.tickTester();
      }
      this.showroom.update(dt, this.menuCam);
      this.renderer.render(this.showroom.scene, this.menuCam);
    }

    _gameFrame(dt) {
      const inp = this.input, p = this.phys;
      if (this.state === 'paused') {
        this.ui.handleNav(inp.nav);
        this.ui.tickTester();
        if (inp.consumePressed('pause') && this.ui.current === 'pause') this.resume();
        this.renderer.render(this.world.scene, this.gameCam);
        return;
      }
      // ---- discrete actions
      if (inp.consumePressed('pause') || inp.nav.some((n) => n.type === 'start' && n.device === 'pad')) { this.pause(); return; }
      if (inp.consumePressed('camera')) { const m = this.rig.next(); MX.toast(this.rig.modeName(), '', 1200); this.audio.ui('hover'); void m; }
      if (inp.consumePressed('reset')) { this.resetBike(); }
      if (!p.crashed) {
        if (inp.consumePressed('shiftUp')) p.shift(1);
        if (inp.consumePressed('shiftDown')) p.shift(-1);
      }
      // ---- analog input into the physics
      const o = inp.out;
      Object.assign(p.input, { throttle: o.throttle, front: o.front, rear: o.rear, clutch: o.clutch, lean: o.lean, rider: o.rider });
      // ---- physics: fixed 500 Hz steps
      this.accum += dt;
      let steps = 0;
      while (this.accum >= DT && steps < MAX_STEPS) { p.step(DT); this.accum -= DT; steps++; }
      if (steps >= MAX_STEPS) this.accum = 0;
      this.physSteps = steps;
      // ---- events
      for (const e of p.consumeEvents()) this._event(e);
      // ---- crash flow
      if (p.crashed) {
        if (this.autoResetIn <= 0) this.autoResetIn = 4.5;
        this.autoResetIn -= dt;
        if (this.autoResetIn <= 0) this.resetBike();
      }
      // ---- laps
      this._laps(dt);
      // ---- visuals
      this._syncModel(dt);
      const S = this.settings;
      const msens = 0.0042 * S.gameplay.cameraSensitivity;
      this.rig.settings.invertX = S.gameplay.invertX; this.rig.settings.invertY = S.gameplay.invertY;
      if (inp.mouse.dx || inp.mouse.dy) this.rig.addLook(inp.mouse.dx * msens, inp.mouse.dy * msens);
      if (Math.abs(o.camX) + Math.abs(o.camY) > 0.01) {
        const k = 2.6 * dt;
        this.rig.addLook(o.camX * k * (S.controller.invertX ? -1 : 1), o.camY * k * (S.controller.invertY ? -1 : 1));
      }
      if (inp.mouse.wheel) this.rig.zoom(inp.mouse.wheel * 0.08);
      this.rig.update(dt, p, this.model);
      // helmet camera sits inside the helmet: hide the head so the peak doesn't block the view
      const hideHead = this.rig.mode === 'helmet' && !p.crashed;
      this.model.rp.head.visible = !hideHead; this.model.rp.neck.visible = !hideHead;
      this.fx.update(dt, p);
      this.world.update(dt, p.pos, this.gameCam);
      this.audio.updateEngine(p, dt, false);
      this.hud.update(dt, this);
      this.renderer.render(this.world.scene, this.gameCam);
    }

    _syncModel(dt) {
      const p = this.phys, m = this.model;
      m.root.position.copy(p.origin);
      m.root.quaternion.copy(p.q);
      const w = p.wheels;
      // in the air, the rider tucks the bike: show the whip lean on the body
      m.update({
        sF: w[0].s, sR: w[1].s, steer: p.steer, wheelF: w[0].angle, wheelR: w[1].angle,
        rider: p.rider, lean: p.crashed ? 0 : p.lean, whip: p.airborne ? p.input.lean : 0,
        detachedRider: p.crashed,
      });
      if (p.crashed && p.crash) {
        const rd = p.crash.rider;
        if (m.rider.parent !== this.world.scene) this.world.scene.add(m.rider);
        m.rider.position.copy(rd.pos);
        // settle the body flat on the ground once it slows down
        if (rd.rest > 0.15 || rd.vel.lengthSq() < 4) {
          const flat = _q1.setFromUnitVectors(_up, _v1.set(rd.vel.x || 0.3, 0, rd.vel.z || 0.1).normalize());
          rd.q.slerp(flat, 1 - Math.exp(-dt * 3));
        }
        m.rider.quaternion.copy(rd.q);
        m.poseCrashed(p.crash.t);
      }
    }

    _event(e) {
      const a = this.audio;
      switch (e.type) {
        case 'land': {
          a.land(e.strength);
          this.rig.addShake(clamp(e.strength / 10, 0, 0.8));
          this.input.rumble(clamp(e.strength / 10, 0, 1), clamp(e.strength / 14, 0, 1), 120 + e.strength * 15);
          for (const w of this.phys.wheels) if (w.contact) this.fx.burst(w.cp, e.strength * 0.8);
          this.hud.air(e.air, e.height);
          break;
        }
        case 'impact': a.bottom(e.strength / 10); this.input.rumble(0.6, 0.3, 120); break;
        case 'shift': a.shift(e.dir > 0); break;
        case 'shiftDenied': a.ui('error'); break;
        case 'crash':
          a.crash();
          this.rig.addShake(1);
          this.input.rumble(1, 1, 450);
          this.fx.burst(this.phys.pos, 12);
          break;
        case 'stall': MX.toast('Stalled · pull the clutch to restart', 'bad', 2600); break;
        case 'bump': a.bottom(0.3); break;
      }
    }

    _laps(dt) {
      const L = this.lap, t = this.track, p = this.phys;
      if (L.running) L.time += dt;
      if (p.crashed) return;
      const q = {};
      if (!t.query(p.pos.x, p.pos.z, q)) { L.prevS = null; return; }
      if (Math.abs(q.d) < t.w + 6) this.lastTrackS = q.s;
      const s = q.s, prev = L.prevS;
      L.prevS = s;
      if (prev == null) return;
      let d = s - prev;
      if (d < -t.length / 2) d += t.length; else if (d > t.length / 2) d -= t.length;
      if (d <= 0 || d > 25) return;              // only count forward progress
      const crossed = (c) => { let a = c - prev; a = ((a % t.length) + t.length) % t.length; return a > 0 && a <= d; };
      if (L.running && L.nextCp < L.cps.length && crossed(L.cps[L.nextCp])) L.nextCp++;
      if (crossed(t.finishS)) {
        if (!L.running) {
          L.running = true; L.started = true; L.time = 0; L.nextCp = 0; L.invalid = false;
          MX.toast('Lap timing started', '', 1500);
        } else if (L.nextCp >= L.cps.length && !L.invalid) {
          const lt = L.time;
          L.lastLap = lt; L.lapCount++;
          const key = t.id + '|' + this.spec.id;
          if (!L.best || lt < L.best) {
            const prevBest = L.best;
            L.best = lt; this.records[key] = lt; MX.saveRecords(this.records);
            MX.toast('NEW BEST  ' + MX.fmtLap(lt) + (prevBest ? '  (−' + (prevBest - lt).toFixed(3) + ')' : ''), 'big good', 4000);
            this.audio.ui('best');
          } else {
            MX.toast('LAP  ' + MX.fmtLap(lt) + '  (+' + (lt - L.best).toFixed(3) + ')', 'big', 3500);
            this.audio.ui('lap');
          }
          L.time = 0; L.nextCp = 0; L.invalid = false;
        } else {
          MX.toast(L.invalid ? 'Lap not counted (bike was reset)' : 'Lap not counted (missed part of the track)', 'bad', 2500);
          L.time = 0; L.nextCp = 0; L.invalid = false;
        }
      }
    }
  }
  const _q1 = new THREE.Quaternion(), _v1 = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

  MX.start = function () {
    const g = new Game();
    MX.game = g;
    g.init();
  };
});
