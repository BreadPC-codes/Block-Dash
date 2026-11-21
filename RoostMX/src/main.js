// Roost MX — game bootstrap, state machine and main loop.
import * as THREE from 'three';
import { loadSettings, saveSettings, loadRecords, saveRecords } from './settings.js';
import { TRACKS, getTrackDef } from './tracks.js';
import { Track, generateTerrain } from './track.js';
import { TerrainView, makeTerrainMaterial, buildBackdrop } from './terrain-render.js';
import { makeTerrainTextures } from './textures.js';
import { Environment, QUALITY_PRESETS } from './environment.js';
import { BikePhysics, PHYSICS_DT } from './physics.js';
import { ProceduralBikeVisual } from './bike.js';
import { Rider } from './rider.js';
import { CameraRig, CAMERA_LABELS } from './camera.js';
import { Particles, TireMarks } from './particles.js';
import { Input } from './controls.js';
import { PAD } from './controller.js';
import { AudioSystem } from './audio.js';
import { UI } from './ui.js';
import { Garage } from './garage.js';
import { ImportedBikeVisual, loadModel } from './bike-importer.js';
import { getBike } from './storage.js';
import { SURF, SURFACES } from './heightfield.js';
import { GEO } from './bike-geometry.js';
import { formatTime, formatDelta, clamp, lerp } from './util.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

// ---------------------------------------------------------------------------------
// Lap timing with checkpoints
// ---------------------------------------------------------------------------------
class LapTimer {
  constructor(track) {
    this.track = track;
    this.n = track.checkpoints.length;
    this.reset();
  }
  reset() {
    this.lapStart = null;
    this.lap = 0;
    this.nextCp = 1;
    this.valid = false;
    this.prevRel = null;
    this.hint = -1;
    this.last = null;
    this.sessionBest = null;
    this.splits = [];
    this.lastSplitDelta = null;
    this.invalidReason = '';
  }
  rel(s) {
    const L = this.track.length;
    let r = (s - this.track.finishS) % L;
    if (r < 0) r += L;
    return r;
  }
  /** Returns an array of events: {type:'lapStart'|'lap'|'cp'|'invalid', ...} */
  update(x, z, now, bestSplits) {
    const tr = this.track;
    const pr = tr.project(x, z, this.hint);
    this.hint = pr.index;
    const L = tr.length;
    const rel = this.rel(pr.s);
    const ev = [];
    const w = tr.interp(tr.W, pr.s);
    if (pr.dist > w + 22 && this.valid) {
      this.valid = false;
      this.invalidReason = 'Off track';
      ev.push({ type: 'invalid', reason: 'Off track — lap invalid' });
    }
    if (this.prevRel != null) {
      const d = rel - this.prevRel;
      if (d < -L / 2) {
        // crossed the finish line forwards
        if (this.lapStart != null && this.valid && this.nextCp >= this.n) {
          const time = now - this.lapStart;
          this.last = time;
          if (this.sessionBest == null || time < this.sessionBest) this.sessionBest = time;
          ev.push({ type: 'lap', time, splits: this.splits.slice() });
        }
        this.lapStart = now;
        this.lap++;
        this.nextCp = 1;
        this.valid = true;
        this.invalidReason = '';
        this.splits = [];
        this.lastSplitDelta = null;
        ev.push({ type: 'lapStart', lap: this.lap });
      } else if (d > L / 2) {
        if (this.valid) ev.push({ type: 'invalid', reason: 'Wrong way — lap invalid' });
        this.valid = false;
        this.invalidReason = 'Wrong way';
      } else if (this.lapStart != null && d > 0) {
        for (let k = 1; k < this.n; k++) {
          const cr = (k * L) / this.n;
          if (this.prevRel < cr && rel >= cr) {
            if (k === this.nextCp) {
              this.nextCp++;
              const split = now - this.lapStart;
              this.splits.push(split);
              const bs = bestSplits && bestSplits[k - 1];
              this.lastSplitDelta = bs != null ? split - bs : null;
              ev.push({ type: 'cp', k, split, delta: this.lastSplitDelta });
            } else if (k > this.nextCp && this.valid) {
              this.valid = false;
              this.invalidReason = 'Missed checkpoint';
              ev.push({ type: 'invalid', reason: 'Missed a checkpoint — lap invalid' });
            }
          }
        }
      }
    }
    this.prevRel = rel;
    return ev;
  }
  current(now) {
    return this.lapStart == null ? null : now - this.lapStart;
  }
  nextCheckpoint() {
    if (this.lapStart == null) return this.track.checkpoints[0];
    return this.track.checkpoints[this.nextCp % this.n];
  }
}

// ---------------------------------------------------------------------------------
class Game {
  constructor() {
    this.settings = loadSettings();
    this.records = loadRecords();
    this.state = 'loading';
    this.canvas = document.getElementById('gl');
    this.quality = QUALITY_PRESETS[this.settings.graphics.quality] || QUALITY_PRESETS.medium;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.quality.antialias, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.08, 6000);
    this.input = new Input(this.settings);
    this.input.attach(window, this.canvas);
    this.audio = new AudioSystem(this.settings);
    this.ui = new UI(this);
    this.garage = new Garage(this);
    this.importCache = new Map();
    this.activeBikeName = 'Roost 450 (procedural)';
    this.bikeDirty = false;
    this.mode = this.settings.game.mode;
    this.time = 0;
    this.fps = { frames: 0, t: 0, value: 0, ms: 0 };
    this.acc = 0;
    this.renderPos = new THREE.Vector3();
    this.renderQuat = new THREE.Quaternion();
    this.crashAuto = 0;
    this.lastHud = 0;
    this.countdown = 0;
    this.world = null;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (this.state === 'riding' || this.state === 'countdown')) this.pause();
    });
    // first user gesture starts audio
    const unlock = () => {
      this.audio.init().catch(() => {});
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.input.pad.on('connect', (gp) => {
      const name = (gp.id || 'Gamepad').replace(/\(.*?\)/g, '').trim().slice(0, 40) || 'Gamepad';
      this.ui.toast(`Controller connected: ${name}`, 'good');
      this.ui.setPadStatus(name);
      this.input.pad.rumble(0.3, 0.3, 150);
    });
    this.input.pad.on('disconnect', () => {
      this.ui.toast('Controller disconnected', 'bad');
      this.ui.setPadStatus('');
      if (this.state === 'riding' || this.state === 'countdown') this.pause();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F11' || (e.code === 'Enter' && e.altKey)) {
        e.preventDefault();
        this.setFullscreen(!this.isFullscreen());
      }
    });
    this.resize();
  }

  // ---------------------------------------------------------------------------------
  async boot() {
    if (this.settings.graphics.fullscreen && window.roostNative) this.setFullscreen(true);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    // restore the active imported bike name
    if (this.settings.game.activeBike !== 'procedural') {
      try {
        const rec = await getBike(this.settings.game.activeBike);
        if (rec) this.activeBikeName = rec.name + ' (imported)';
        else this.settings.game.activeBike = 'procedural';
      } catch (e) {
        this.settings.game.activeBike = 'procedural';
      }
    }
    await this.loadTrack(this.settings.game.track);
    this.state = 'menu';
    this.ui.go('main', { push: false });
    const pads = this.input.pad;
    if (pads.connected) this.ui.setPadStatus(pads.id.replace(/\(.*?\)/g, '').trim().slice(0, 40));
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.world && this.world.particles) this.world.particles.setViewport(h * pr, this.camera.fov);
    this.garage.resize(w, h);
  }

  // ---------------------------------------------------------------------------------
  async loadTrack(id) {
    const def = getTrackDef(id);
    const prevState = this.state;
    this.state = 'loading';
    this.ui.go('loading', { push: false });
    this.ui.showHud(false);
    this.ui.setLoading(0.02, 'Laying out ' + def.name + '…');
    await nextFrame();
    this.disposeWorld();
    const q = this.quality;
    const track = new Track(def);
    this.ui.setLoading(0.12, 'Shaping terrain…');
    await nextFrame();
    const hf = generateTerrain(track);
    this.ui.setLoading(0.42, 'Painting dirt and grass…');
    await nextFrame();
    const texSize = q.terrain === 'low' ? 512 : 1024;
    if (!this.terrainTex || this.terrainTexSize !== texSize) {
      if (this.terrainTex) Object.values(this.terrainTex).forEach((t) => t.dispose());
      this.terrainTex = makeTerrainTextures(texSize);
      this.terrainTexSize = texSize;
    }
    const terrainMat = makeTerrainMaterial(this.terrainTex, { sandy: def.surface === 'sand' });
    const terrainView = new TerrainView(hf, track);
    this.scene.add(terrainView.build(q.terrain, terrainMat));
    const backdrop = buildBackdrop(track, hf, def.groundStyle, q.terrain);
    this.scene.add(backdrop);
    this.ui.setLoading(0.6, 'Planting trees and building the venue…');
    await nextFrame();
    const env = new Environment({ renderer: this.renderer, scene: this.scene, track, hf, quality: this.settings.graphics.quality, terrainStyle: def.groundStyle }).build();
    this.renderer.shadowMap.enabled = q.shadows;
    this.ui.setLoading(0.78, 'Preparing the bike…');
    await nextFrame();
    const physics = new BikePhysics(hf, env.colliders);
    const particles = new Particles(this.scene, q.particles);
    const marks = new TireMarks(this.scene, q.terrain === 'low' ? 300 : 700);
    const rig = new CameraRig(this.camera, hf);
    rig.setMode(this.settings.camera.mode || 'chase');
    this.world = { def, track, hf, terrainView, terrainMat, backdrop, env, physics, particles, marks, rig, timer: new LapTimer(track) };
    this.applyPhysicsTune();
    this.applyCameraSettings();
    await this.buildBikeVisual();
    this.spawnAtStart();
    this.ui.buildMinimap(track);
    this.resize();
    this.ui.setLoading(0.92, 'Warming up the engine…');
    await nextFrame();
    try {
      if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      /* not critical */
    }
    this.ui.setLoading(1, 'Ready');
    this.state = prevState === 'loading' ? 'menu' : prevState;
    return this.world;
  }

  disposeWorld() {
    const w = this.world;
    if (!w) return;
    this.scene.remove(w.terrainView.group);
    w.terrainView.dispose();
    w.terrainMat.dispose();
    this.scene.remove(w.backdrop);
    w.backdrop.geometry.dispose();
    w.backdrop.material.dispose();
    w.env.dispose();
    w.particles.dispose();
    w.marks.dispose();
    this.removeBikeVisual();
    this.world = null;
  }

  // ---------------------------------------------------------------------------------
  // Bike visuals
  async loadImportedSource(rec) {
    if (this.importCache.has(rec.id)) return this.importCache.get(rec.id);
    const main = rec.main || (rec.files.find((f) => /\.(glb|gltf|fbx|obj)$/i.test(f.name)) || {}).name;
    const loaded = await loadModel(rec.files, main, this.renderer);
    const entry = { root: loaded.root, animations: loaded.animations };
    this.importCache.set(rec.id, entry);
    return entry;
  }

  cacheImportedSource(id, entry) {
    this.importCache.set(id, entry);
  }

  removeBikeVisual() {
    if (this.bikeVisual) {
      this.scene.remove(this.bikeVisual.root);
      this.bikeVisual.dispose();
      this.bikeVisual = null;
    }
    if (this.rider) {
      if (this.rider.group.parent) this.rider.group.parent.remove(this.rider.group);
      this.rider.dispose();
      this.rider = null;
    }
  }

  async buildBikeVisual() {
    this.removeBikeVisual();
    const s = this.settings;
    let visual = null;
    let showRider = true;
    const riderOffset = new THREE.Vector3();
    if (s.game.activeBike !== 'procedural') {
      try {
        const rec = await getBike(s.game.activeBike);
        if (!rec) throw new Error('missing');
        const src = await this.loadImportedSource(rec);
        visual = new ImportedBikeVisual(src.root, rec.config, src.animations);
        visual.setColor(s.bike.color);
        showRider = rec.config.rider.show;
        visual.riderOffset(riderOffset);
        this.activeBikeName = rec.name + ' (imported)';
      } catch (e) {
        console.warn('Imported bike unavailable, using procedural bike', e);
        this.ui.toast('Imported bike could not be loaded — using the Roost 450', 'bad');
        s.game.activeBike = 'procedural';
        saveSettings(s);
        visual = null;
      }
    }
    if (!visual) {
      visual = new ProceduralBikeVisual(s.bike.color, s.bike.number);
      this.activeBikeName = 'Roost 450 (procedural)';
    }
    visual.root.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.bikeVisual = visual;
    this.scene.add(visual.root);
    this.rider = new Rider(s.bike.color);
    this.rider.group.position.copy(riderOffset);
    this.riderOffset = riderOffset;
    this.showRider = showRider;
    this.rider.group.visible = showRider;
    visual.root.add(this.rider.group);
    this.bikeDirty = false;
  }

  // ---------------------------------------------------------------------------------
  applyPhysicsTune() {
    if (!this.world) return;
    const b = this.settings.bike;
    this.world.physics.applyTune({
      steerSens: b.steerSens,
      enginePower: b.enginePower,
      suspStiffness: b.suspStiffness,
      suspDamping: b.suspDamping,
      brakeFront: b.brakeFront,
      brakeRear: b.brakeRear,
      assist: b.assist,
      autoGearbox: b.autoGearbox,
    });
  }

  applyCameraSettings() {
    if (!this.world) return;
    this.world.rig.sensitivity = this.settings.camera.sensitivity;
    this.world.rig.distanceScale = this.settings.camera.distance;
  }

  applySetting(path, value) {
    const [group] = path.split('.');
    if (group === 'bike') {
      this.applyPhysicsTune();
      if (path === 'bike.color') {
        if (this.bikeVisual) this.bikeVisual.setColor(value);
        if (this.rider) this.rider.setColor(value);
      }
      if (path === 'bike.number') this.bikeDirty = true;
    } else if (group === 'camera') {
      this.applyCameraSettings();
    } else if (group === 'audio') {
      this.audio.applyVolumes();
    } else if (path === 'graphics.fullscreen') {
      this.setFullscreen(value);
    } else if (path === 'graphics.quality') {
      const prevAA = this.quality.antialias;
      this.quality = QUALITY_PRESETS[value];
      if (prevAA !== this.quality.antialias) this.ui.toast('Antialiasing changes apply after restarting the game.');
      this.ui.toast('Applying ' + value + ' quality…');
      this.reloadWorld();
    }
  }

  async reloadWorld() {
    const ret = this.state;
    const ui = this.ui.screen;
    const keep = this.world ? { pos: this.world.physics.pos.clone(), quat: this.world.physics.quat.clone() } : null;
    await this.loadTrack(this.settings.game.track);
    if (keep && (ret === 'paused' || ret === 'riding')) {
      this.state = 'paused';
      this.resetBike();
    } else this.state = ret === 'loading' ? 'menu' : ret;
    if (ui && ui !== 'loading' && ui !== 'ride') this.ui.show(ui);
    else this.ui.go(this.state === 'paused' ? 'pause' : 'main', { push: false });
  }

  isFullscreen() {
    if (window.roostNative && window.roostNative.isFullscreenSync) return window.roostNative.isFullscreenSync();
    return !!document.fullscreenElement;
  }

  setFullscreen(on) {
    if (window.roostNative) {
      window.roostNative.setFullscreen(on);
    } else {
      try {
        if (on && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
        if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }
    if (this.settings.graphics.fullscreen !== on) {
      this.settings.graphics.fullscreen = on;
      saveSettings(this.settings);
    }
  }

  // ---------------------------------------------------------------------------------
  // Spawning / resets
  spawnAtStart() {
    const w = this.world;
    const tr = w.track;
    const s = tr.gateS - 2.2;
    const p = tr.pose(s, 0);
    w.physics.reset(_v.set(p.x, 0, p.z), p.heading);
    w.rig.snapNext = true;
    w.marks.clear();
    w.particles.clear();
    w.timer.reset();
    this.acc = 0;
    this.crashAuto = 0;
    this.attachRider();
  }

  resetBike() {
    const w = this.world;
    const ph = w.physics;
    const tr = w.track;
    const ref = ph.crashed && ph.ragdoll.active ? ph.pos : ph.pos;
    const pr = tr.project(ref.x, ref.z, w.timer.hint);
    const s = tr.safeRespawnS(pr.s);
    const p = tr.pose(s, 0);
    ph.reset(_v.set(p.x, 0, p.z), p.heading);
    w.rig.snapNext = true;
    w.marks.break(0);
    w.marks.break(1);
    this.crashAuto = 0;
    this.attachRider();
    // keep lap progress consistent
    w.timer.hint = tr.idx(s);
    w.timer.prevRel = w.timer.rel(s);
    this.ui.clearNotify();
  }

  attachRider() {
    if (!this.rider || !this.bikeVisual) return;
    if (this.rider.group.parent !== this.bikeVisual.root) {
      if (this.rider.group.parent) this.rider.group.parent.remove(this.rider.group);
      this.bikeVisual.root.add(this.rider.group);
    }
    this.rider.group.position.copy(this.riderOffset || _v.set(0, 0, 0));
    this.rider.group.quaternion.identity();
    this.rider.group.visible = this.showRider;
    this.rider.flail = 0;
  }

  // ---------------------------------------------------------------------------------
  // State transitions
  async startRide() {
    this.audio.init().catch(() => {});
    this.mode = this.settings.game.mode;
    if (this.bikeDirty) await this.buildBikeVisual();
    if (this.world.def.id !== this.settings.game.track) await this.loadTrack(this.settings.game.track);
    this.spawnAtStart();
    this.ui.hideMenus();
    this.ui.showHud(true);
    this.input.clearRiding();
    const env = this.world.env;
    if (this.mode === 'trial') {
      env.setGateDown(false, true);
      this.state = 'countdown';
      this.countdown = 3.999;
      this.lastCount = 5;
    } else {
      env.setGateDown(true, true);
      this.state = 'riding';
      this.ui.notify('Free Ride', this.world.def.name, '', 1800);
    }
    this.world.rig.setMode(this.settings.camera.mode || 'chase');
    this.world.rig.snapNext = true;
    this.sessionStart = this.time;
  }

  restartSession() {
    this.ui.hideMenus();
    this.ui.showHud(true);
    this.startRide();
  }

  pause() {
    if (this.state !== 'riding' && this.state !== 'countdown') return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.audio.silenceRide();
    this.ui.showHud(false);
    this.ui.go('pause', { push: false });
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = this.pausedFrom || 'riding';
    this.ui.hideMenus();
    this.ui.showHud(true);
    this.input.clearRiding();
    this.acc = 0;
  }

  toMainMenu() {
    this.state = 'menu';
    this.audio.silenceRide();
    this.ui.showHud(false);
    this.world.env.setGateDown(true, true);
    this.spawnAtStart();
    this.ui.history = [];
    this.ui.go('main', { push: false });
  }

  async selectTrack(id) {
    this.settings.game.track = id;
    saveSettings(this.settings);
    const fromPause = this.state === 'paused';
    if (!this.world || this.world.def.id !== id) {
      await this.loadTrack(id);
    }
    this.ui.history = [];
    if (fromPause) {
      this.state = 'menu';
      this.ui.go('play', { push: false });
    } else {
      this.state = 'menu';
      this.ui.go('main', { push: false });
      this.ui.go('play');
    }
  }

  async openGarage() {
    this.garageFrom = this.state;
    this.audio.silenceRide();
    this.state = 'garage';
    this.ui.showHud(false);
    this.ui.go('garage');
    await this.garage.open();
  }

  async closeGarage(ride) {
    this.garage.close();
    if (this.bikeDirty) await this.buildBikeVisual();
    else if (this.bikeVisual) {
      this.bikeVisual.setColor(this.settings.bike.color);
      this.rider && this.rider.setColor(this.settings.bike.color);
    }
    this.attachRider();
    if (ride) {
      this.state = 'menu';
      this.ui.history = [];
      this.startRide();
      return;
    }
    if (this.garageFrom === 'paused') {
      this.state = 'paused';
      this.ui.history = [];
      this.ui.go('pause', { push: false });
    } else {
      this.state = 'menu';
      this.ui.history = [];
      this.ui.go('main', { push: false });
    }
  }

  async quit() {
    if (window.roostNative) {
      window.roostNative.quit();
      return;
    }
    await this.ui.modal('Quit', 'You are playing in a browser — close this tab or window to quit.<br><br>The desktop version quits directly.', [{ label: 'OK', primary: true }]);
  }

  // ---------------------------------------------------------------------------------
  // Main loop
  loop(now) {
    requestAnimationFrame(this.loop);
    const t = now / 1000;
    let dt = this.lastT ? t - this.lastT : 1 / 60;
    this.lastT = t;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;
    this.time += dt;
    const f = this.fps;
    f.frames++;
    f.t += dt;
    if (f.t >= 0.5) {
      f.value = f.frames / f.t;
      f.frames = 0;
      f.t = 0;
    }
    const inp = this.input.update(dt);
    try {
      switch (this.state) {
        case 'menu':
        case 'paused':
          this.menuInput(dt, inp);
          this.updateMenuScene(dt);
          this.render();
          break;
        case 'riding':
        case 'countdown':
          this.updateRide(dt, inp);
          this.render();
          break;
        case 'garage':
          this.menuInput(dt, inp);
          this.garage.update(dt);
          this.garage.render();
          break;
        case 'loading':
        default:
          if (this.world) this.render();
          break;
      }
    } catch (e) {
      console.error(e);
    }
    this.input.endFrame();
  }

  render() {
    if (!this.world) return;
    this.renderer.render(this.scene, this.camera);
  }

  menuInput(dt, inp) {
    const ui = this.ui;
    const pad = this.input.pad;
    const k = this.input;
    if (ui.listening) return;
    const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text');
    if (!typing) {
      if (k.keyPressed('ArrowUp')) ui.navigate('up');
      if (k.keyPressed('ArrowDown')) ui.navigate('down');
      if (k.keyPressed('ArrowLeft')) ui.navigate('left');
      if (k.keyPressed('ArrowRight')) ui.navigate('right');
      if (k.keyPressed('Enter') || k.keyPressed('NumpadEnter')) ui.activate();
    }
    if (k.keyPressed('Escape')) {
      if (ui._modalOpen) { const b = document.querySelector('#modal-btns .btn'); if (b) b.click(); }
      else ui.back();
    }
    if (pad.connected) {
      const d = pad.nav(dt);
      if (d) ui.navigate(d);
      if (pad.pressed(PAD.A)) ui.activate();
      if (pad.pressed(PAD.B)) {
        if (ui._modalOpen) { const b = document.querySelector('#modal-btns .btn'); if (b) b.click(); }
        else ui.back();
      }
      if (pad.pressed(PAD.START) && this.state === 'paused') this.resume();
      if (this.state === 'garage') {
        const o = this.input.orbit(dt);
        if (o.dx || o.dy) {
          this.garage.controls.autoRotate = false;
          const sph = new THREE.Spherical().setFromVector3(this.garage.camera.position.clone().sub(this.garage.controls.target));
          sph.theta -= o.dx;
          sph.phi = clamp(sph.phi + o.dy, 0.3, Math.PI * 0.49);
          this.garage.camera.position.setFromSpherical(sph).add(this.garage.controls.target);
        }
      }
    }
    void inp;
  }

  updateMenuScene(dt) {
    const w = this.world;
    if (!w) return;
    if (this.state === 'menu') {
      // bike idles at the start, camera orbits
      this.syncBikeVisual(dt, true);
      w.physics.originWorld(_v);
      _v.y += 0.4;
      w.rig.updateMenu(dt, _v);
    }
    w.env.update(dt, w.physics.pos);
    w.particles.update(dt, w.hf);
  }

  // ---------------------------------------------------------------------------------
  updateRide(dt, inp) {
    const w = this.world;
    const ph = w.physics;
    if (inp.pause) {
      this.pause();
      return;
    }
    // countdown (time trial)
    let frozen = false;
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this.lastCount && n > 0) {
        this.lastCount = n;
        this.ui.notify(String(n), '', 'count', 900);
        this.audio.beep(false);
      }
      if (this.countdown <= 0) {
        this.state = 'riding';
        w.env.setGateDown(true);
        this.ui.notify('GO!', '', 'go', 900);
        this.audio.beep(true);
        this.audio.gateDrop();
      }
      frozen = this.countdown > 0;
    }
    // discrete inputs
    if (inp.camera) {
      const m = w.rig.next();
      this.settings.camera.mode = m;
      saveSettings(this.settings);
      this.rider.setFirstPerson(m === 'helmet');
      this.ui.toast(CAMERA_LABELS[m]);
    }
    if (inp.shiftUp || inp.shiftDown) {
      if (this.settings.bike.autoGearbox) {
        this.settings.bike.autoGearbox = false;
        saveSettings(this.settings);
        this.applyPhysicsTune();
        this.ui.toast('Manual gearbox (switch back in Bike Settings)');
      }
      if (!ph.crashed && ph.engine.shift(inp.shiftUp ? 1 : -1)) this.audio.shift();
    }
    const resetReq = inp.reset && (ph.crashed ? ph.crashTimer > 0.6 : true);
    if (resetReq) {
      this.resetBike();
    }
    if (ph.crashed) {
      this.crashAuto += dt;
      if (this.crashAuto > 4.5 || (ph.ragdoll.settle > 1.5 && this.crashAuto > 2.5)) this.resetBike();
    }
    // fall in the sea / far below the map
    if (ph.pos.y < -1.6 && w.def.seaSide) this.resetBike();

    // fixed-step physics
    const ride = { throttle: inp.throttle, brakeF: inp.brakeF, brakeR: inp.brakeR, steer: inp.steer, lean: inp.lean };
    if (frozen) {
      ride.throttle = Math.min(ride.throttle, 0.35);
      ride.brakeF = 1;
      ride.brakeR = 1;
    }
    this.acc += dt;
    let steps = 0;
    while (this.acc >= PHYSICS_DT && steps < 30) {
      ph.step(PHYSICS_DT, ride);
      this.acc -= PHYSICS_DT;
      steps++;
    }
    if (steps >= 30) this.acc = 0;
    // physics events
    for (const e of ph.events) this.onPhysicsEvent(e);
    ph.events.length = 0;

    this.syncBikeVisual(dt, false);
    // camera
    const orbit = this.input.orbit(dt);
    if (orbit.dx || orbit.dy) w.rig.orbit(orbit.dx, orbit.dy);
    const wheel = this.input.wheel();
    const ctx = this._camCtx(inp);
    const free = w.rig.mode === 'free' ? { ...this.input.freeCam(), wheel: -wheel } : null;
    if (w.rig.mode !== 'free' && wheel) {
      this.settings.camera.distance = clamp(this.settings.camera.distance + wheel * 0.06, 0.7, 1.6);
      this.applyCameraSettings();
    }
    w.rig.update(dt, ctx, free);
    // world
    w.env.update(dt, ph.pos);
    this.emitEffects(dt);
    w.particles.update(dt, w.hf);
    w.marks.update(dt);
    // lap timing
    if (!frozen) {
      const rec = this.records[w.def.id];
      const evs = w.timer.update(ph.pos.x, ph.pos.z, this.time, rec && rec.splits);
      for (const e of evs) this.onTimerEvent(e);
    }
    // audio
    const rear = ph.rear, front = ph.front;
    const skid = (rear.contact ? Math.max(0, rear.slideSpeed - 1.5) : 0) + (front.contact ? Math.max(0, front.slideSpeed - 1.5) : 0);
    const roost = rear.contact ? Math.max(0, rear.omega * rear.radius - rear.slideSpeed * 0) * clamp(rear.slipRatio * 3, 0, 1) * ph.throttle : 0;
    this.audio.updateRide({
      engineOn: !ph.crashed || ph.engine.rpm > 900,
      rpm: ph.crashed ? Math.max(0, ph.engine.rpm * Math.max(0, 1 - ph.crashTimer)) : ph.engine.rpm,
      load: ph.crashed ? 0 : ph.engine.load,
      speed: ph.speed,
      skid,
      roost,
      rough: Math.min(0.4, (Math.abs(front.compression - (this._lastCompF || 0)) + Math.abs(rear.compression - (this._lastCompR || 0))) * 4),
      surface: rear.surface === SURF.SAND ? 'sand' : 'dirt',
      grounded: !ph.airborne,
      cameraMode: w.rig.mode,
    });
    this._lastCompF = front.compression;
    this._lastCompR = rear.compression;
    // HUD (throttled to ~30 Hz)
    this.lastHud += dt;
    if (this.lastHud > 1 / 30) {
      this.lastHud = 0;
      this.updateHud();
    }
  }

  _camCtx(inp) {
    const w = this.world;
    const ph = w.physics;
    const crashed = ph.crashed;
    const focus = _v2;
    if (crashed && ph.ragdoll.active) focus.copy(ph.ragdoll.pos).lerp(ph.pos, 0.4);
    else focus.copy(this.renderPos);
    let eye = null;
    if (w.rig.mode === 'helmet' && this.rider && !crashed) {
      eye = new THREE.Vector3().copy(this.rider.j.headC).add(new THREE.Vector3(0, 0.03, 0.14));
      this.rider.group.localToWorld(eye);
    }
    return {
      quat: crashed ? ph.quat : this.renderQuat,
      vel: ph.vel,
      speed: ph.speed,
      airborne: ph.airborne,
      crashed,
      focus,
      eye,
      lookBack: inp.lookBack,
    };
  }

  /** Place the visual bike/rider from the (interpolated) physics state. */
  syncBikeVisual(dt, idle) {
    const w = this.world;
    const ph = w.physics;
    const vis = this.bikeVisual;
    if (!vis) return;
    const alpha = clamp(this.acc / PHYSICS_DT, 0, 1);
    ph.interpolated(alpha, this.renderPos, this.renderQuat);
    // bike-space origin = CoM - R*com, plus the chassis shift along up
    _v.set(-ph.com.x, -ph.com.y + ph.chassisShift, -ph.com.z).applyQuaternion(this.renderQuat);
    vis.root.position.copy(this.renderPos).add(_v);
    vis.root.quaternion.copy(this.renderQuat);
    vis.update({ steer: ph.steerAngle, compF: ph.front.visComp, compR: ph.rear.visComp, spinF: ph.front.angle, spinR: ph.rear.angle }, dt);
    const rider = this.rider;
    if (!rider) return;
    if (ph.crashed && ph.ragdoll.active) {
      if (rider.group.parent !== this.scene) {
        this.scene.attach(rider.group);
      }
      rider.group.position.copy(ph.ragdoll.pos);
      rider.group.quaternion.copy(ph.ragdoll.quat);
      rider.group.visible = this.showRider;
      rider.updateRagdoll(dt, ph.ragdoll.grounded);
      if (rider.firstPerson) rider.setFirstPerson(false);
    } else {
      if (rider.group.parent !== vis.root) this.attachRider();
      const gl = _gl, gr = _gr;
      vis.grips(gl, gr, ph.steerAngle);
      rider.updateRiding(dt, {
        stance: idle ? 0.15 : ph.stance,
        riderLean: ph.riderLean,
        legE: ph.riderE,
        lean: ph.leanAngle,
        steer: ph.steerAngle,
        speed: ph.speed,
        airborne: ph.airborne,
        whip: ph.airborne ? ph.steerIn : 0,
        brake: ph.brakeF,
      }, gl, gr);
      const fp = w.rig.mode === 'helmet' && this.state !== 'menu';
      if (rider.firstPerson !== fp) rider.setFirstPerson(fp);
    }
  }

  // ---------------------------------------------------------------------------------
  emitEffects(dt) {
    const w = this.world;
    const ph = w.physics;
    const P = w.particles;
    const q = this.quality;
    const budget = q.particles / 1300;
    for (const wh of ph.wheels) {
      if (!wh.contact) {
        w.marks.break(wh.isFront ? 0 : 1);
        continue;
      }
      const surf = SURFACES[wh.surface];
      const col = surf.color;
      const cp = wh.point;
      const spinSpeed = wh.omega * wh.radius;
      const vLong = ph.vel.dot(ph.fwd);
      const wheelSpin = Math.max(0, spinSpeed - vLong);
      // roost: rear wheel spinning faster than the ground
      if (!wh.isFront && wheelSpin > 1.2) {
        const n = Math.min(14, wheelSpin * 3.2 * budget * dt * 60 * 0.35);
        for (let i = 0; i < n; i++) {
          if (Math.random() > n) break;
          const back = -(2 + Math.random() * 3 + wheelSpin * 0.5);
          const vx = ph.fwd.x * back + (Math.random() - 0.5) * 2.2 + ph.vel.x * 0.6;
          const vz = ph.fwd.z * back + (Math.random() - 0.5) * 2.2 + ph.vel.z * 0.6;
          const vy = 1.2 + Math.random() * 3.2;
          const shade = 0.75 + Math.random() * 0.4;
          P.emit(cp.x, cp.y + 0.05, cp.z, vx, vy, vz, 0.5 + Math.random() * 0.6, 0.07 + Math.random() * 0.08, 0.05, col[0] * shade * 0.8, col[1] * shade * 0.8, col[2] * shade * 0.8, 1, 9.8, 0.3);
        }
      }
      // dust when moving fast on loose surfaces
      const sp = ph.speed;
      const dustRate = surf.dust * clamp((sp - 5) / 18, 0, 1) * (wh.isFront ? 0.4 : 1) + wh.slideSpeed * 0.05 * surf.dust;
      if (dustRate > 0 && Math.random() < dustRate * dt * 26 * budget) {
        P.emit(cp.x + (Math.random() - 0.5) * 0.4, cp.y + 0.2, cp.z + (Math.random() - 0.5) * 0.4,
          ph.vel.x * 0.25 + (Math.random() - 0.5), 0.4 + Math.random() * 0.6, ph.vel.z * 0.25 + (Math.random() - 0.5),
          1.6 + Math.random() * 1.6, 0.6, 2.8 + Math.random() * 1.5, col[0] * 1.35 + 0.08, col[1] * 1.3 + 0.07, col[2] * 1.25 + 0.06, 0.22, -0.15, 1.2);
      }
      // tire marks while sliding or braking hard
      const sliding = wh.slideSpeed > 2.2 || (wh.isFront ? ph.brakeF : ph.brakeR) > 0.7 && Math.abs(wh.omega) < 3 && sp > 2;
      const sandRut = wh.surface === SURF.SAND && sp > 1;
      if (sliding || sandRut) {
        const a = sandRut && !sliding ? 0.18 : clamp(wh.slideSpeed / 8, 0.25, 0.6);
        w.marks.add(wh.isFront ? 0 : 1, cp, wh.normal, wh.isFront ? 0.1 : 0.14, [col[0] * 0.55, col[1] * 0.5, col[2] * 0.45], a);
      } else {
        w.marks.break(wh.isFront ? 0 : 1);
      }
    }
  }

  burst(pos, count, col, power) {
    const P = this.world.particles;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * power;
      P.emit(pos.x, pos.y + 0.1, pos.z, Math.cos(a) * r, 0.6 + Math.random() * power * 0.6, Math.sin(a) * r, 1.2 + Math.random(), 0.8, 3 + Math.random() * 2, col[0] * 1.3 + 0.1, col[1] * 1.25 + 0.08, col[2] * 1.2 + 0.07, 0.26, -0.1, 1.5);
      if (i % 3 === 0) P.emit(pos.x, pos.y + 0.1, pos.z, Math.cos(a) * r * 1.5, 1.5 + Math.random() * 3, Math.sin(a) * r * 1.5, 0.7, 0.08, 0.05, col[0] * 0.8, col[1] * 0.8, col[2] * 0.8, 1, 9.8, 0.3);
    }
  }

  onPhysicsEvent(e) {
    const w = this.world;
    const ph = w.physics;
    if (e.type === 'land') {
      this.audio.land(e.impact);
      const col = SURFACES[ph.rear.surface].color;
      if (e.impact > 2) this.burst(ph.rear.contact ? ph.rear.point : ph.pos, Math.min(30, Math.round(e.impact * 3)), col, 1 + e.impact * 0.3);
      this.input.pad.rumble(Math.min(1, e.impact / 10), Math.min(1, e.impact / 14), 120 + e.impact * 20);
    } else if (e.type === 'crash') {
      this.audio.crash();
      this.burst(ph.pos, 40, SURFACES[ph.rear.surface].color, 3);
      this.input.pad.rumble(1, 1, 450);
      this.crashAuto = 0;
    } else if (e.type === 'shift') {
      this.audio.shift();
    } else if (e.type === 'scrape') {
      this.audio.scrape();
    } else if (e.type === 'bump') {
      this.audio.bump(e.amount);
    }
  }

  onTimerEvent(e) {
    const w = this.world;
    const id = w.def.id;
    if (e.type === 'lap') {
      const rec = this.records[id];
      const isBest = !rec || e.time < rec.best;
      if (isBest) {
        this.records[id] = { best: e.time, splits: e.splits, date: Date.now(), mode: this.mode };
        saveRecords(this.records);
        this.ui.notify('Best lap!', formatTime(e.time), 'best', 2600);
        this.audio.bestLap();
      } else {
        this.ui.notify('Lap ' + (w.timer.lap - 1), formatTime(e.time) + '  ' + formatDelta(e.time - rec.best), '', 2200);
        this.audio.checkpoint();
      }
    } else if (e.type === 'lapStart') {
      if (e.lap === 1) this.ui.notify('Lap 1', 'timing started', '', 1400);
    } else if (e.type === 'cp') {
      this.audio.checkpoint();
    } else if (e.type === 'invalid') {
      this.ui.toast(e.reason, 'bad', 2500);
    }
  }

  updateHud() {
    const w = this.world;
    const ph = w.physics;
    const tm = w.timer;
    const rec = this.records[w.def.id];
    const cur = tm.current(this.time);
    let lapLabel;
    if (this.state === 'countdown') lapLabel = 'GET READY';
    else if (tm.lapStart == null) lapLabel = this.mode === 'trial' ? 'OUT LAP' : 'CROSS THE LINE';
    else lapLabel = (tm.valid ? 'LAP ' + tm.lap : 'LAP ' + tm.lap + ' · INVALID');
    let split = '', splitCls = '';
    if (tm.lastSplitDelta != null && tm.valid) {
      split = formatDelta(tm.lastSplitDelta);
      splitCls = tm.lastSplitDelta > 0 ? 'pos' : 'neg';
    }
    const crashHint = this.input.lastDevice === 'gamepad' ? 'Press Ⓐ to reset' : 'Press R to reset';
    const auto = Math.max(0, 4.5 - this.crashAuto);
    this.ui.updateHud({
      speed: ph.forwardSpeed,
      gear: ph.engine.gear,
      auto: this.settings.bike.autoGearbox,
      rpm: ph.engine.rpm,
      mode: this.mode === 'trial' ? 'TIME TRIAL' : 'FREE RIDE',
      lapLabel,
      lapTime: cur == null ? '0:00.000' : formatTime(cur),
      best: rec ? formatTime(rec.best) : '--:--.---',
      last: tm.last != null ? formatTime(tm.last) : '--:--.---',
      split,
      splitCls,
      camLabel: CAMERA_LABELS[w.rig.mode].toUpperCase(),
      airTime: ph.airborne ? ph.airTime : 0,
      crashed: ph.crashed,
      crashReason: ph.crashReason,
      crashHint: crashHint + ` · auto reset in ${auto.toFixed(0)}`,
      fpsText: `${this.fps.value.toFixed(0)} FPS · ${this.renderer.info.render.calls} calls · ${(this.renderer.info.render.triangles / 1000).toFixed(0)}k tris`,
    });
    const hdg = Math.atan2(ph.fwd.x, ph.fwd.z);
    this.ui.drawMinimap(ph.pos.x, ph.pos.z, hdg, tm.nextCheckpoint());
  }
}

const _gl = new THREE.Vector3(), _gr = new THREE.Vector3();

// ---------------------------------------------------------------------------------
function start() {
  try {
    const game = new Game();
    window.__roost = game;
    game.boot().catch((e) => {
      console.error(e);
      showFatal(e);
    });
  } catch (e) {
    console.error(e);
    showFatal(e);
  }
}

function showFatal(e) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = 'Could not start: ' + (e && e.message ? e.message : e);
  const tip = document.getElementById('loading-tip');
  if (tip) tip.textContent = 'WebGL 2 is required. Update your graphics drivers or try another browser.';
}

void lerp; void GEO; void TRACKS;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
