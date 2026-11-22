// Roost MX — game bootstrap, state machine and main loop.
import * as THREE from 'three';
import { loadSettings, saveSettings, loadRecords, saveRecords, hasSavedSettings, padLabel, keyLabel } from './settings.js';
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
import { getBike, getTrackRecord, listTrackSummaries, saveTrackRecord, deleteTrackRecord, updateTrackRecord } from './storage.js';
import { buildImportedWorld, isImportedId, IMPORT_PREFIX, summary as importSummary, drawImportedPreview } from './imported-track.js';
import { readTrackPackage, TrackImportError } from './mxb-track.js';
import { SURF, SURFACES } from './heightfield.js';
import { GEO } from './bike-geometry.js';
import { formatTime, formatDelta, clamp, lerp } from './util.js';
import { LapTimer } from './timing.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

// ---------------------------------------------------------------------------------
class Game {
  constructor() {
    this.settings = loadSettings();
    this.records = loadRecords();
    this.state = 'loading';
    this.canvas = document.getElementById('gl');
    this.quality = QUALITY_PRESETS[this.settings.graphics.quality] || QUALITY_PRESETS.medium;
    const firstRun = !hasSavedSettings();
    const aaSetting = this.settings.graphics.antialias;
    this.antialias = aaSetting === 'on' ? true : aaSetting === 'off' ? false : this.quality.antialias;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.antialias, powerPreference: 'high-performance', stencil: false });
    if (firstRun) this.autoQuality();
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
    this.importedTracks = []; // summaries of imported MX Bikes tracks (see imported-track.js)
    // track markers (one per track, this session): hold the marker key on the ground to set
    // one, tap it to go back there
    this.markers = {};
    this._mk = { down: false, t: 0, hold: 0, done: false, block: false, last: 0 };
    this.activeBikeName = 'Roost 450 (procedural)';
    this.bikeDirty = false;
    this.mode = this.settings.game.mode;
    this.time = 0;
    this.fps = { frames: 0, t: 0, value: 0, ms: 0 };
    this.acc = 0;
    this.renderPos = new THREE.Vector3();
    this.renderQuat = new THREE.Quaternion();
    // reused every frame (no garbage in the hot path)
    this._ride = { throttle: 0, brakeF: 0, brakeR: 0, steer: 0, lean: 0, side: 0 };
    this._ctx = { quat: null, vel: null, speed: 0, airborne: false, crashed: false, focus: null, eye: null, lookBack: false };
    this._eye = new THREE.Vector3();
    this._free = { fx: 0, fy: 0, fz: 0, fast: false, wheel: 0 };
    this._pose = { stance: 0, riderLean: 0, side: 0, legE: 0, lean: 0, steer: 0, speed: 0, airborne: false, whip: 0, brake: 0, twist: 0, upper: 0, lookAt: null };
    this._bikeState = { steer: 0, compF: 0, compR: 0, spinF: 0, spinR: 0 };
    // dynamic resolution: scales the render resolution to hold the display's frame rate
    this.dyn = { scale: 1, acc: 0, frames: 0, ok: 0, upDelay: 2, since: 0, lastUp: -1e9, refresh: 60, pAcc: 0 };
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
    // drop MX Bikes track packages on the track list to import them
    window.addEventListener('dragover', (e) => {
      if (this.ui.screen === 'tracks') e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (this.ui.screen !== 'tracks' || !e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      this.importTrackFiles(e.dataTransfer.files);
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F11' || (e.code === 'Enter' && e.altKey)) {
        e.preventDefault();
        this.setFullscreen(!this.isFullscreen());
      }
      if (e.code === 'F3' && !e.repeat) {
        // physics debug overlay (also in Settings > Graphics)
        e.preventDefault();
        const g = this.settings.graphics;
        g.physicsDebug = !g.physicsDebug;
        saveSettings(this.settings);
        this.ui.toast(g.physicsDebug ? 'Physics debug overlay on (F3 to hide)' : 'Physics debug overlay off');
      }
    });
    this.resize();
  }

  /** First launch: choose a graphics preset that suits the detected GPU. */
  autoQuality() {
    let name = '';
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch (e) {
      /* ignore */
    }
    let q = 'high';
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) q = 'low';
    else if (/intel|uhd|iris|mali|adreno|powervr|apple m1|vega \d graphics|radeon\(tm\) graphics/i.test(name)) q = 'medium';
    this.gpuName = name;
    this.settings.graphics.quality = q;
    this.quality = QUALITY_PRESETS[q];
    saveSettings(this.settings);
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
    await this.refreshImportedTracks();
    await this.loadTrack(this.settings.game.track);
    this.state = 'menu';
    this.ui.go('main', { push: false });
    const pads = this.input.pad;
    if (pads.connected) this.ui.setPadStatus(pads.id.replace(/\(.*?\)/g, '').trim().slice(0, 40));
  }

  /** Device pixel ratio actually rendered: preset cap x render scale x dynamic scale. */
  pixelRatio() {
    const base = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio) * clamp(this.settings.graphics.renderScale || 1, 0.5, 1);
    return Math.max(0.3, base * (this.dyn ? this.dyn.scale : 1));
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = this.pixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.world && this.world.particles) this.world.particles.setViewport(h * pr, this.camera.fov);
    this.garage.resize(w, h);
    this.pausedDirty = true;
  }

  // ---------------------------------------------------------------------------------
  async loadTrack(id) {
    let imported = null;
    if (isImportedId(id)) {
      try {
        imported = await getTrackRecord(id.slice(IMPORT_PREFIX.length));
      } catch (e) {
        imported = null;
      }
      if (!imported) {
        this.ui.toast('That imported track is no longer stored. Loading ' + TRACKS[0].name + ' instead.', 'bad', 4500);
        id = TRACKS[0].id;
        this.settings.game.track = id;
        saveSettings(this.settings);
      }
    }
    let def = imported ? { name: imported.name } : getTrackDef(id);
    const prevState = this.state;
    this.state = 'loading';
    this.ui.go('loading', { push: false });
    this.ui.showHud(false);
    this.ui.setLoading(0.02, 'Laying out ' + def.name + '…');
    await nextFrame();
    this.disposeWorld();
    const q = this.quality;
    const T = (this.loadTimes = {});
    let tm = performance.now();
    const lap = (k) => { const n = performance.now(); T[k] = Math.round(n - tm); tm = n; };
    let track, hf;
    if (imported) {
      this.ui.setLoading(0.12, 'Building the imported terrain…');
      await nextFrame();
      tm = performance.now();
      ({ def, track, hf } = buildImportedWorld(imported, imported.scale ?? 1));
      lap('heightfield');
    } else {
      track = new Track(def);
      lap('track');
      this.ui.setLoading(0.12, 'Shaping terrain…');
      await nextFrame();
      tm = performance.now();
      hf = generateTerrain(track);
      lap('heightfield');
    }
    this.ui.setLoading(0.42, 'Painting dirt and grass…');
    await nextFrame();
    tm = performance.now();
    const texSize = q.terrain === 'low' ? 512 : 1024;
    const texKey = texSize + ':' + q.aniso;
    if (!this.terrainTex || this.terrainTexKey !== texKey) {
      if (this.terrainTex) Object.values(this.terrainTex).forEach((t) => t && t.isTexture && t.dispose());
      this.terrainTex = makeTerrainTextures(texSize, q.aniso);
      this.terrainTexKey = texKey;
    }
    const terrainMat = makeTerrainMaterial(this.terrainTex, { sandy: def.surface === 'sand', quality: q.terrain });
    lap('textures');
    const terrainView = new TerrainView(hf, track);
    this.scene.add(terrainView.build(q.terrain, terrainMat));
    const backdrop = buildBackdrop(track, hf, def.groundStyle, q.terrain);
    this.scene.add(backdrop);
    lap('terrainMesh');
    this.ui.setLoading(0.6, 'Planting trees and building the venue…');
    await nextFrame();
    tm = performance.now();
    const env = new Environment({ renderer: this.renderer, scene: this.scene, track, hf, quality: this.settings.graphics.quality, terrainStyle: def.groundStyle }).build();
    lap('environment');
    this.renderer.shadowMap.enabled = q.shadows;
    this.ui.setLoading(0.78, 'Preparing the bike…');
    await nextFrame();
    const physics = new BikePhysics(hf, env.colliders);
    const particles = new Particles(this.scene, q.particles);
    const marks = new TireMarks(this.scene, q.terrain === 'low' ? 300 : 700);
    const rig = new CameraRig(this.camera, hf);
    rig.setMode(this.settings.camera.mode || 'chase');
    const markerMesh = buildMarkerMesh();
    this.scene.add(markerMesh);
    this.world = { def, track, hf, terrainView, terrainMat, backdrop, env, physics, particles, marks, rig, markerMesh, timer: new LapTimer(track) };
    this.placeMarkerMesh();
    this.applyPhysicsTune();
    this.applyCameraSettings();
    await this.buildBikeVisual();
    this.spawnAtStart();
    this.ui.buildMinimap(track);
    this.resize();
    lap('bike');
    this.ui.setLoading(0.92, 'Warming up the engine…');
    await nextFrame();
    tm = performance.now();
    try {
      if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      /* not critical */
    }
    lap('shaders');
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
    if (w.markerMesh) {
      this.scene.remove(w.markerMesh);
      w.markerMesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
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
      grip: b.grip,
      airControl: b.airControl ?? 1,
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
    this.pausedDirty = true;
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
    } else if (path === 'graphics.antialias') {
      this.ui.toast('Anti-aliasing changes apply after restarting the game.');
    } else if (path === 'graphics.renderScale' || path === 'graphics.dynamicRes') {
      if (path === 'graphics.dynamicRes' && !value) this.dyn.scale = 1;
      this.resize();
    } else if (path === 'graphics.quality') {
      this.quality = QUALITY_PRESETS[value];
      if (this.settings.graphics.antialias === 'auto' && this.antialias !== this.quality.antialias) this.ui.toast('Anti-aliasing changes apply after restarting the game.');
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
  // Imported MX Bikes tracks (.pkz)
  async refreshImportedTracks() {
    try {
      this.importedTracks = (await listTrackSummaries()).sort((a, b) => (b.created || 0) - (a.created || 0));
    } catch (e) {
      this.importedTracks = [];
    }
    return this.importedTracks;
  }

  /** Name of a track id (built-in or imported). */
  trackName(id) {
    if (isImportedId(id)) {
      const t = this.importedTracks.find((x) => IMPORT_PREFIX + x.id === id);
      return t ? t.name : 'Imported track';
    }
    return getTrackDef(id).name;
  }

  _thumb(rec, scale) {
    const cv = document.createElement('canvas');
    cv.width = 360;
    cv.height = 220;
    drawImportedPreview(cv, rec, scale);
    try {
      return cv.toDataURL('image/jpeg', 0.86);
    } catch (e) {
      return '';
    }
  }

  /** File picker / drag & drop: read MX Bikes track packages and import them. */
  async importTrackFiles(files) {
    const list = Array.from(files || []).filter((f) => /\.(pkz|zip)$/i.test(f.name));
    if (!list.length) {
      this.ui.toast('Choose an MX Bikes track package (.pkz or .zip).', 'bad');
      return;
    }
    const back = this.ui.screen;
    let lastId = null;
    for (const file of list) {
      let tracks;
      this.ui.go('loading', { push: false });
      this.ui.setLoading(0.02, 'Reading ' + file.name + '…');
      await nextFrame();
      try {
        tracks = await readTrackPackage(file, { onProgress: (p, text) => this.ui.setLoading(0.05 + p * 0.9, text) });
      } catch (e) {
        this.ui.show(back);
        const msg = e instanceof TrackImportError ? e.message : 'Could not read ' + file.name + ': ' + e.message;
        await this.ui.modal('Track import failed', '<p class="note">' + escapeHtml(msg) + '</p>');
        continue;
      }
      this.ui.show(back);
      for (const rec of tracks) {
        const choice = await this.ui.trackImportDialog(rec, { scale: 1, surface: /sand|dune|beach/i.test(rec.name + rec.folder) ? 'sand' : 'dirt' });
        if (!choice) continue;
        rec.scale = choice.scale;
        rec.surface = choice.surface;
        rec.created = Date.now();
        try {
          await saveTrackRecord(rec, { ...importSummary(rec), thumb: this._thumb(rec, rec.scale) });
          lastId = IMPORT_PREFIX + rec.id;
          this.ui.toast('Imported ' + rec.name, 'good');
        } catch (e) {
          await this.ui.modal('Could not save the track', '<p class="note">' + escapeHtml(e.message || String(e)) + '</p>');
        }
      }
    }
    await this.refreshImportedTracks();
    if (lastId) await this.selectTrack(lastId, { stay: true });
    else if (this.ui.screen === 'tracks') this.ui.buildTrackCards();
  }

  /** Change the scale / ground of an imported track. */
  async editImportedTrack(id) {
    const key = id.slice(IMPORT_PREFIX.length);
    const rec = await getTrackRecord(key);
    if (!rec) return;
    const choice = await this.ui.trackImportDialog(rec, { scale: rec.scale ?? 1, surface: rec.surface || 'dirt', edit: true });
    if (!choice) return;
    rec.scale = choice.scale;
    rec.surface = choice.surface;
    await saveTrackRecord(rec, { ...importSummary(rec), thumb: this._thumb(rec, rec.scale) });
    await this.refreshImportedTracks();
    // best times were set at the old size
    if (this.records[id]) {
      delete this.records[id];
      saveRecords(this.records);
    }
    if (this.world && this.world.def.id === id) await this.loadTrack(id);
    this.ui.go('tracks', { push: false });
  }

  async deleteImportedTrack(id) {
    const name = this.trackName(id);
    const ok = await this.ui.modal('Delete track', '<p class="note">Remove <b>' + escapeHtml(name) + '</b> from Roost MX? The .pkz file itself is not touched.</p>', [{ label: 'Delete', primary: true, value: true }, { label: 'Cancel', value: false }]);
    if (!ok) return;
    await deleteTrackRecord(id.slice(IMPORT_PREFIX.length));
    await this.refreshImportedTracks();
    if (this.records[id]) {
      delete this.records[id];
      saveRecords(this.records);
    }
    if (this.settings.game.track === id) await this.selectTrack(TRACKS[0].id, { stay: true });
    else this.ui.buildTrackCards();
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
    w.timer.teleported(s);
    this.ui.clearNotify();
  }

  // ---------------------------------------------------------------------------------
  // Track marker: hold the marker key (default the down arrow) for 3 s with the wheels on the
  // ground to drop a marker; a quick tap brings the bike back to it. A longer press is just
  // rider lean back (the default key does both), and taps in the air are pitch corrections.
  _blockMarker() {
    const mk = this._mk;
    mk.block = true; // until the key is released
    mk.down = false;
    this.ui.markerHold(0);
  }

  updateMarker(dt, inp, frozen) {
    const mk = this._mk;
    const ph = this.world.physics;
    if (mk.block) {
      if (!inp.marker) mk.block = false;
      return;
    }
    // timed on the wall clock: "hold for 3 seconds" is real seconds, also on a slow machine
    // where the game's own clock can fall behind
    const now = performance.now() / 1000;
    if (inp.marker && !frozen) {
      if (!mk.down) { mk.down = true; mk.t = 0; mk.hold = 0; mk.done = false; mk.last = now; }
      const step = Math.min(0.5, now - mk.last);
      mk.last = now;
      mk.t += step;
      mk.hold = !ph.airborne && !ph.crashed ? mk.hold + step : 0;
      if (!mk.done) {
        if (mk.hold >= MARKER_HOLD) {
          mk.done = true;
          this.ui.markerHold(0);
          this.setMarker();
        } else {
          this.ui.markerHold(mk.hold > 0.35 ? mk.hold / MARKER_HOLD : 0);
        }
      }
    } else if (mk.down) {
      mk.down = false;
      this.ui.markerHold(0);
      if (!mk.done && mk.t < MARKER_TAP && this.markers[this.world.def.id] && (ph.crashed || !ph.airborne)) this.respawnAtMarker();
    }
  }

  markerKeyLabel() {
    const k = (this.settings.controls.keys.marker || []).find((c) => c);
    const p = (this.settings.controls.pad.marker || []).find((c) => c);
    if (this.input.lastDevice === 'gamepad' && p) return padLabel(p, this.input.pad.standard);
    return k ? keyLabel(k) : p ? padLabel(p, this.input.pad.standard) : 'the marker key';
  }

  setMarker() {
    const w = this.world, ph = w.physics;
    this.markers[w.def.id] = { x: ph.pos.x, z: ph.pos.z, heading: Math.atan2(ph.fwd.x, ph.fwd.z) };
    this.placeMarkerMesh();
    this.audio.uiSelect();
    this.ui.notify('Marker set', 'Tap ' + this.markerKeyLabel() + ' to come back here', '', 2400);
  }

  respawnAtMarker() {
    const w = this.world, ph = w.physics;
    const m = this.markers[w.def.id];
    if (!m) return;
    ph.reset(_v.set(m.x, 0, m.z), m.heading);
    w.rig.snapNext = true;
    w.marks.break(0);
    w.marks.break(1);
    this.crashAuto = 0;
    this.attachRider();
    const tm = w.timer;
    if (!w.def.noTiming && tm.valid && (tm.lapStart != null || w.track.open)) {
      tm.valid = false;
      tm.invalidReason = 'Marker';
      this.ui.toast('Lap invalid - back to the marker', 'bad', 2200);
    }
    tm.teleported(w.track.project(m.x, m.z, -1).s);
    this.ui.notify('Back to the marker', '', '', 1100);
  }

  /** Put the marker flag where this track's marker is (hidden without one). */
  placeMarkerMesh() {
    const w = this.world;
    if (!w || !w.markerMesh) return;
    const m = this.markers[w.def.id];
    w.markerMesh.visible = !!m;
    if (!m) return;
    w.markerMesh.position.set(m.x, w.hf.height(m.x, m.z), m.z);
    w.markerMesh.rotation.y = m.heading;
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
    this.returnTimer = 0;
    this.audio.init().catch(() => {});
    this.mode = this.settings.game.mode;
    if (this.bikeDirty) await this.buildBikeVisual();
    if (this.world.def.id !== this.settings.game.track) await this.loadTrack(this.settings.game.track);
    if (this.world.def.noTiming && this.mode === 'trial') {
      this.mode = 'free';
      this.ui.toast('This track has no timing line, so it is ridden in Free Ride.', '', 4000);
    }
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
    this._blockMarker();
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
    this._blockMarker();
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

  async selectTrack(id, { stay = false } = {}) {
    this.settings.game.track = id;
    saveSettings(this.settings);
    const fromPause = this.state === 'paused';
    if (!this.world || this.world.def.id !== id) {
      await this.loadTrack(id);
    }
    if (stay) {
      // (after importing / deleting) back on the track list with the new selection
      this.state = fromPause ? 'paused' : 'menu';
      this.ui.history = fromPause ? ['pause'] : ['main'];
      this.ui.go('tracks', { push: false });
      return;
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
      // the fastest sustained rate seen is the display's refresh rate
      if (f.value > this.dyn.refresh * 1.05) this.dyn.refresh = Math.min(240, f.value);
      // one-time hint when riding stays slow even at the lowest dynamic resolution
      if (this.state === 'riding' && !this.slowHintShown) {
        const floor = !this.settings.graphics.dynamicRes || this.dyn.scale <= 0.52;
        f.slow = f.value < 38 && floor ? (f.slow || 0) + 0.5 : 0;
        if (f.slow > 8 && this.settings.graphics.quality !== 'low') {
          this.slowHintShown = true;
          this.ui.toast('Low frame rate — try a lower Graphics quality in Settings.', 'bad', 6000);
        }
      }
    }
    if (this.state === 'riding' || this.state === 'countdown' || this.state === 'menu') this.updateDynRes(dt);
    const inp = this.input.update(dt);
    try {
      switch (this.state) {
        case 'menu':
          this.menuInput(dt, inp);
          this.updateMenuScene(dt);
          this.render();
          break;
        case 'paused':
          // the world is frozen behind the pause menu: redraw it rarely to save power
          this.menuInput(dt, inp);
          this.dyn.pAcc += dt;
          if (this.dyn.pAcc > 0.1 || this.pausedDirty) {
            this.dyn.pAcc = 0;
            this.pausedDirty = false;
            this.updateMenuScene(dt);
            this.render();
          }
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
    if (this.scene.fog) this.world.terrainView.cull(this.camera.position, this.scene.fog.far);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Dynamic resolution: when the frame rate drops below the display rate (max 60) the
   * render resolution is lowered step by step; when there is headroom it is raised again.
   * A rise that immediately drops frames doubles the wait before the next attempt, so the
   * scale settles instead of oscillating.
   */
  updateDynRes(dt) {
    const d = this.dyn;
    d.acc += dt;
    d.frames++;
    if (d.acc < 0.5) return;
    const fps = d.frames / d.acc;
    d.acc = 0;
    d.frames = 0;
    d.since += 0.5;
    if (!this.settings.graphics.dynamicRes) {
      if (d.scale !== 1) {
        d.scale = 1;
        this.resize();
      }
      return;
    }
    const goal = Math.min(60, d.refresh);
    if (fps < goal * 0.92 && d.scale > 0.5 && d.since >= 1) {
      d.scale = Math.max(0.5, d.scale * (fps < goal * 0.7 ? 0.8 : 0.9));
      if (this.time - d.lastUp < 4) d.upDelay = Math.min(40, d.upDelay * 2);
      d.since = 0;
      d.ok = 0;
      this.resize();
    } else if (fps >= goal * 0.97) {
      d.ok += 0.5;
      if (d.ok >= d.upDelay && d.scale < 1) {
        d.scale = Math.min(1, d.scale * 1.08 + 0.01);
        d.lastUp = this.time;
        d.since = 0;
        d.ok = 0;
        this.resize();
      }
    } else {
      d.ok = 0;
    }
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
    // clear a binding slot with Delete / Backspace
    if ((k.keyPressed('Delete') || k.keyPressed('Backspace')) && !typing && ui.focusEl && ui.focusEl._clear) ui.focusEl._clear();
    if (pad.connected) {
      const d = pad.nav(dt);
      if (d) ui.navigate(d);
      if (pad.pressed(PAD.A)) ui.activate();
      if (pad.pressed(PAD.X) && ui.focusEl && ui.focusEl._clear) ui.focusEl._clear();
      if (pad.pressed(PAD.B)) {
        if (ui._modalOpen) { const b = document.querySelector('#modal-btns .btn'); if (b) b.click(); }
        else ui.back();
      }
      if ((pad.pressed(PAD.START) || this.input.padPressed('pause')) && this.state === 'paused') this.resume();
      if (this.state === 'garage') {
        const o = this.input.orbit(dt, true);
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
    w.env.update(dt, w.physics.pos, this.camera);
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
    this.updateMarker(dt, inp, frozen);
    if (ph.crashed) {
      this.crashAuto += dt;
      if (this.crashAuto > 4.5 || (ph.ragdoll.settle > 1.5 && this.crashAuto > 2.5)) this.resetBike();
    }
    // fall in the sea / far below the map
    if (ph.pos.y < -1.6 && w.def.seaSide) this.resetBike();

    // fixed-step physics
    const ride = this._ride;
    ride.throttle = inp.throttle;
    ride.brakeF = inp.brakeF;
    ride.brakeR = inp.brakeR;
    ride.steer = inp.steer;
    ride.lean = inp.lean;
    ride.side = inp.side || 0;
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
    if (this.returnTimer > 0) {
      this.returnTimer -= dt;
      if (this.returnTimer <= 0) {
        this.returnTimer = 0;
        this.startRide();
        return;
      }
    }

    this.syncBikeVisual(dt, false);
    // camera
    const orbit = this.input.orbit(dt);
    if (orbit.dx || orbit.dy) w.rig.orbit(orbit.dx, orbit.dy);
    const wheel = this.input.wheel();
    const ctx = this._camCtx(inp);
    let free = null;
    if (w.rig.mode === 'free') {
      free = this.input.freeCam(this._free);
      free.wheel = -wheel;
    }
    if (w.rig.mode !== 'free' && wheel) {
      this.settings.camera.distance = clamp(this.settings.camera.distance + wheel * 0.06, 0.7, 1.6);
      this.applyCameraSettings();
    }
    w.rig.update(dt, ctx, free);
    // world
    w.env.update(dt, ph.pos, this.camera);
    if (w.markerMesh.visible) w.markerMesh.userData.flag.rotation.y = Math.sin(this.time * 3.1) * 0.25 + Math.sin(this.time * 7.3) * 0.08;
    this.emitEffects(dt);
    w.particles.update(dt, w.hf);
    w.marks.update(dt);
    // lap timing
    if (!frozen && !w.def.noTiming) {
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
      eye = this._eye.copy(this.rider.j.headC);
      eye.y += 0.03;
      eye.z += 0.14;
      this.rider.group.localToWorld(eye);
    }
    const c = this._ctx;
    c.quat = crashed ? ph.quat : this.renderQuat;
    c.vel = ph.vel;
    c.speed = ph.speed;
    c.airborne = ph.airborne;
    c.crashed = crashed;
    c.focus = focus;
    c.eye = eye;
    c.lookBack = inp.lookBack;
    return c;
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
    const bs = this._bikeState;
    bs.steer = ph.steerAngle;
    bs.compF = ph.front.visComp;
    bs.compR = ph.rear.visComp;
    bs.spinF = ph.front.angle;
    bs.spinR = ph.rear.angle;
    vis.update(bs, dt);
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
      const ps = this._pose;
      ps.stance = idle ? 0.15 : ph.stance;
      ps.riderLean = ph.riderLean;
      ps.side = idle ? 0 : ph.riderSide || 0;
      ps.legE = ph.riderE;
      ps.lean = ph.leanAngle;
      ps.steer = ph.steerAngle;
      ps.speed = ph.speed;
      ps.airborne = ph.airborne;
      // whips: the rider's upper body counter-rotates (physics DOFs in whip.js) and the
      // head looks where the bike is going while its rear swings out
      ps.whip = ph.airborne ? ph.whip.whipEffort : 0;
      ps.twist = ph.whip.riderTwist;
      ps.upper = ph.whip.riderLean;
      ps.lookAt = ph.airborne ? ph.whip.whipAngle : null;
      ps.brake = ph.brakeF;
      rider.updateRiding(dt, ps, gl, gr);
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
    } else if (e.type === 'takeoff') {
      this.audio.takeoff(e.speed);
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
    const open = w.track.open;
    if (e.type === 'finish') {
      // point-to-point track: back to the start gate a few seconds after the finish line
      this.returnTimer = 3.5;
      if (!e.valid && (this.mode === 'trial' || this.settings.graphics.freeRideTimer)) this.ui.notify('Finish', 'run invalid', '', 2200);
      return;
    }
    if (this.mode !== 'trial' && !this.settings.graphics.freeRideTimer) return;
    const id = w.def.id;
    if (e.type === 'lap') {
      const rec = this.records[id];
      const isBest = !rec || e.time < rec.best;
      if (isBest) {
        this.records[id] = { best: e.time, splits: e.splits, date: Date.now(), mode: this.mode };
        saveRecords(this.records);
        this.ui.notify(open ? 'New record!' : 'Best lap!', formatTime(e.time), 'best', 2600);
        this.audio.bestLap();
      } else {
        this.ui.notify(open ? 'Finish' : 'Lap ' + (w.timer.lap - 1), formatTime(e.time) + '  ' + formatDelta(e.time - rec.best), '', 2200);
        this.audio.checkpoint();
      }
    } else if (e.type === 'lapStart') {
      if (open) this.ui.notify('Run ' + e.lap, 'send it!', '', 1400);
      else if (e.lap === 1) this.ui.notify('Lap 1', 'timing started', '', 1400);
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
    const open = w.track.open;
    if (this.state === 'countdown') lapLabel = 'GET READY';
    else if (open && tm.finished) lapLabel = 'FINISHED · BACK TO START';
    else if (tm.lapStart == null) lapLabel = open ? 'GO TO THE GATE' : this.mode === 'trial' ? 'OUT LAP' : 'CROSS THE LINE';
    else {
      const word = open ? 'RUN ' : 'LAP ';
      lapLabel = tm.valid ? word + tm.lap : word + tm.lap + ' · INVALID';
    }
    let split = '', splitCls = '';
    if (tm.lastSplitDelta != null && tm.valid) {
      split = formatDelta(tm.lastSplitDelta);
      splitCls = tm.lastSplitDelta > 0 ? 'pos' : 'neg';
    }
    const ctl = this.settings.controls;
    const padReset = ctl.pad.reset.find((c) => c), keyReset = ctl.keys.reset.find((c) => c);
    const crashHint = this.input.lastDevice === 'gamepad' && padReset ? `Press ${padLabel(padReset, this.input.pad.standard)} to reset` : keyReset ? `Press ${keyLabel(keyReset)} to reset` : 'Resetting';
    const auto = Math.max(0, 4.5 - this.crashAuto);
    this.ui.updateHud({
      // in the air (whips) the speedo keeps showing the speed over the ground
      speed: ph.airborne && !ph.crashed ? Math.hypot(ph.vel.x, ph.vel.z) : ph.forwardSpeed,
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
      showTimer: !w.def.noTiming && (this.mode === 'trial' || this.settings.graphics.freeRideTimer),
      airTime: ph.airborne ? ph.airTime : 0,
      crashed: ph.crashed,
      crashReason: ph.crashReason,
      crashHint: crashHint + ` · auto reset in ${auto.toFixed(0)}`,
      whipDebug: this.settings.graphics.physicsDebug ? this.whipDebugText(ph) : '',
      fpsText: `${this.fps.value.toFixed(0)} FPS · ${Math.round(this.renderer.getPixelRatio() / Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio) * 100)}% res · ${this.renderer.info.render.calls} calls · ${(this.renderer.info.render.triangles / 1000).toFixed(0)}k tris`,
    });
    const hdg = Math.atan2(ph.fwd.x, ph.fwd.z);
    this.ui.drawMinimap(ph.pos.x, ph.pos.z, hdg, w.def.noTiming ? null : tm.nextCheckpoint(), this.markers[w.def.id]);
  }

  /** Text of the physics debug overlay (only built while it is shown). */
  whipDebugText(ph) {
    const W = ph.whip, T = W.torque, s = this.input.state, pad = this.input.pad;
    const D = 180 / Math.PI;
    const f = (v, n = 1, w = 6) => (Number.isFinite(v) ? v : 0).toFixed(n).padStart(w);
    const state = ph.crashed ? 'CRASHED' : ph.airborne ? `AIRBORNE ${ph.airTime.toFixed(2)} s` : W.onFace ? 'GROUNDED · ON A JUMP FACE' : 'GROUNDED';
    return [
      `WHIP / AIR PHYSICS     ${state}`,
      `whip angle ${f(W.whipAngle * D)} deg   yaw rate   ${f(W.whipRate * D, 0)} deg/s`,
      `pitch      ${f(ph.pitchAngle * D)} deg   pitch rate ${f(ph.angVel.dot(ph.right) * D, 0)} deg/s`,
      `roll       ${f(ph.leanAngle * D)} deg   roll rate  ${f(W.rollRate * D, 0)} deg/s`,
      `angular velocity ${f(ph.angVel.length() * D, 0)} deg/s`,
      `torque     yaw ${f(T.yaw, 0)}  roll ${f(T.roll, 0)}  pitch ${f(T.pitch, 0)} N·m`,
      `recovery   yaw ${f(T.recYaw, 0)}  roll ${f(T.recRoll, 0)} N·m  strength ${f(W.recovery, 2, 4)}`,
      `gyro       ${f(T.gyro, 0)} N·m  wheel L ${f(W.gyroL, 0)} N·m·s   aero ${f(T.aero, 0)} N·m`,
      `landing in ${W.landIn > 0 ? f(W.landIn, 2) + ' s' : '     -'}   bars ${f(ph.steerAngle * D)} deg`,
      `effort     whip ${f(W.whipEffort, 2)}  pitch ${f(W.pitchEffort, 2)}  side ${f(W.sideEffort, 2)}`,
      `input      steer ${f(s.steer, 2)}  lean ${f(s.lean, 2)}  side ${f(s.side, 2)}  gas ${f(s.throttle, 2)}  rear brake ${f(s.brakeR, 2)}`,
      pad.connected ? `controller LS ${f(pad.axes[0], 2)} ${f(pad.axes[1], 2)}  RS ${f(pad.axes[2], 2)} ${f(pad.axes[3], 2)}  LT ${f(pad.value(6), 2)}  RT ${f(pad.value(7), 2)}` : 'controller not connected',
      `rider      twist ${f(W.riderTwist * D)} deg  lean ${f(W.riderLean * D)} deg`,
    ].join('\n');
  }
}

const _gl = new THREE.Vector3(), _gr = new THREE.Vector3();
const MARKER_HOLD = 3; // s on the ground to set a marker
const MARKER_TAP = 0.35; // s: a shorter press is a tap (go back to the marker)

/** A small flag on a pole with a ring on the ground: where the track marker is. */
function buildMarkerMesh() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 2.3, 6), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.45, metalness: 0.6 }));
  // the pole stands at the left edge of the ring, beside the spot rather than through the rider
  pole.position.set(1.12, 1.15, 0);
  const flagGeo = new THREE.PlaneGeometry(0.78, 0.46);
  flagGeo.translate(0.39, 0, 0);
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xf26a10, emissive: 0x5a2200, roughness: 0.75, side: THREE.DoubleSide }));
  flag.position.set(1.12, 2.06, 0);
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.25, 40), new THREE.MeshBasicMaterial({ color: 0xf26a10, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  ring.renderOrder = 2;
  pole.castShadow = flag.castShadow = true;
  g.add(pole, flag, ring);
  g.userData.flag = flag;
  g.visible = false;
  return g;
}

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
