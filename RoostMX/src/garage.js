// Garage: studio scene for previewing bikes, painting, importing custom models,
// adjusting them and assigning their animated parts.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ProceduralBikeVisual, BIKE_COLORS } from './bike.js';
import { Rider } from './rider.js';
import { GEO } from './bike-geometry.js';
import {
  readFileList, inspectFiles, loadModel, autoDetect, autoFit, defaultConfig, ImportedBikeVisual, COMPONENT_SLOTS,
  listNodes, listMaterials, nodePath, boundsOf, CONVERSION_GUIDE, fileExt, releaseModel,
} from './bike-importer.js';
import { saveBike, listBikes, deleteBike, getBike, updateBikeConfig } from './storage.js';
import { saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function makeBackdropTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#1b1c20');
  g.addColorStop(1, '#0d0d10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);
  ctx.save();
  ctx.translate(512, 250);
  ctx.transform(1, 0, -0.2, 1, 0, 0);
  ctx.font = 'italic 900 210px "Barlow Condensed", Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillText('ROOST', -60, 0);
  ctx.fillStyle = 'rgba(242,106,16,0.16)';
  ctx.fillText('MX', 260, 0);
  ctx.restore();
  ctx.fillStyle = 'rgba(242,106,16,0.5)';
  ctx.fillRect(0, 470, 1024, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Garage {
  constructor(game) {
    this.game = game;
    this.renderer = game.renderer;
    this.settings = game.settings;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e0e11);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    this.camera.position.set(3.4, 1.5, 3.2);
    this.tab = 'bikes';
    this.visual = null;
    this.rider = null;
    this.source = null; // loaded imported model (pristine)
    this.current = null; // { id, name, format, config, files, animations }
    this.pending = null; // freshly imported, not yet saved
    this.activeSlot = null;
    this.preview = false;
    this.t = 0;
    this.built = false;
    this.bikes = [];
    this.highlight = null;
    this.pickMode = false;
  }

  _build() {
    if (this.built) return;
    this.built = true;
    const s = this.scene;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    s.environment = this.envRT.texture;
    s.environmentIntensity = 0.6;
    pmrem.dispose();
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x232326, roughness: 0.55, metalness: 0.2 });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const turn = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.95, 0.05, 64), new THREE.MeshStandardMaterial({ color: 0x2f3034, roughness: 0.35, metalness: 0.6 }));
    turn.position.y = -0.024;
    turn.receiveShadow = true;
    s.add(turn);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.92, 0.012, 6, 96), new THREE.MeshBasicMaterial({ color: 0xf26a10 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.004;
    s.add(ring);
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(13, 13, 9, 64, 1, true, Math.PI * 0.55, Math.PI * 0.9), new THREE.MeshStandardMaterial({ map: makeBackdropTexture(), side: THREE.BackSide, roughness: 0.9 }));
    wall.position.y = 4.2;
    s.add(wall);
    const key = new THREE.SpotLight(0xfff0dd, 60, 20, 0.6, 0.5, 1.6);
    key.position.set(3, 5.5, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0004;
    s.add(key);
    s.add(key.target);
    const rim = new THREE.SpotLight(0x9cc8ff, 40, 20, 0.7, 0.6, 1.6);
    rim.position.set(-4, 4, -3);
    s.add(rim);
    s.add(new THREE.HemisphereLight(0xdfe8ff, 0x202022, 0.5));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.62, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.4;
    this.controls.maxDistance = 8;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.8;
    this.controls.enabled = false;
    this.controls.addEventListener('start', () => (this.controls.autoRotate = false));
    this.raycaster = new THREE.Raycaster();
    this._down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (this.game.state !== 'garage') return;
      this._down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (this.game.state !== 'garage' || !this._down) return;
      const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
      this._down = null;
      if (moved < 5 && this.pickMode) this._pick(e);
    });
    // drag & drop files onto the window while in the garage
    window.addEventListener('dragover', (e) => {
      if (this.game.state === 'garage') e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (this.game.state !== 'garage') return;
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) {
        this.showTab('import');
        this.importFiles(e.dataTransfer.files);
      }
    });
  }

  async open() {
    this._build();
    this.controls.enabled = true;
    this.bikes = await listBikes().catch(() => []);
    const active = this.settings.game.activeBike;
    if (active !== 'procedural' && this.bikes.some((b) => b.id === active)) await this.loadStored(active);
    else this.showProcedural();
    document.querySelectorAll('#garage-tabs .tab').forEach((t) => {
      t.onclick = () => this.showTab(t.dataset.gtab);
    });
    this.showTab(this.tab);
  }

  close() {
    if (this.controls) this.controls.enabled = false;
    this.pickMode = false;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  status(text, kind) {
    const el = $('garage-status');
    el.textContent = text || '';
    el.style.color = kind === 'bad' ? '#ff7a6b' : kind === 'good' ? '#3ccf6e' : '';
  }

  // ---------------------------------------------------------------------------------
  _clearVisual() {
    if (this.visual) {
      this.scene.remove(this.visual.root);
      if (this.visual.kind === 'procedural') this.visual.dispose();
      else this.visual.dispose();
      this.visual = null;
    }
    if (!this.rider) {
      this.rider = new Rider(this.settings.bike.color);
    }
    this._clearHighlight();
  }

  showProcedural() {
    this._clearVisual();
    if (this.source && !this.pending) {
      releaseModel(this.source);
      this.source = null;
    }
    this.current = { id: 'procedural', name: 'Roost 450', format: 'procedural' };
    this.visual = new ProceduralBikeVisual(this.settings.bike.color, this.settings.bike.number);
    this.scene.add(this.visual.root);
    this._attachRider(true);
    this.status('Procedural Roost 450 — built from code, no files needed.');
  }

  _attachRider(show) {
    if (!this.rider) return;
    if (this.rider.group.parent) this.rider.group.parent.remove(this.rider.group);
    if (!show || !this.visual) return;
    this.visual.root.add(this.rider.group);
    if (this.visual.kind === 'imported') this.visual.riderOffset(this.rider.group.position);
    else this.rider.group.position.set(0, 0, 0);
    this._poseRider(0);
  }

  _poseRider(steer) {
    if (!this.rider || !this.visual || !this.rider.group.parent) return;
    const gl = new THREE.Vector3(), gr = new THREE.Vector3();
    this.visual.grips(gl, gr, steer);
    this.rider.updateRiding(1, { stance: 0.9, riderLean: 0, legE: 0, lean: 0, steer, speed: 0, airborne: false, whip: 0, brake: 0 }, gl, gr);
  }

  async loadStored(id) {
    this.status('Loading bike…');
    try {
      const rec = await getBike(id);
      if (!rec) throw new Error('Bike not found');
      const loaded = await this.game.loadImportedSource(rec);
      if (this.source && this.source !== loaded.root && !this.pending) releaseModel(this.source);
      this.source = loaded.root;
      this.current = { id: rec.id, name: rec.name, format: rec.format, config: rec.config, animations: loaded.animations, main: rec.main };
      this.pending = null;
      this._rebuildImported();
      this.status(`${rec.name} (${rec.format.toUpperCase()})`, 'good');
    } catch (e) {
      console.error(e);
      this.status('Could not load the bike: ' + e.message, 'bad');
      this.showProcedural();
    }
  }

  _rebuildImported() {
    this._clearVisual();
    const cfg = this.current.config;
    this.visual = new ImportedBikeVisual(this.source, cfg, this.current.animations || []);
    this.visual.setColor(this.settings.bike.color);
    this.scene.add(this.visual.root);
    this._attachRider(cfg.rider.show);
    if (this.visual.warnings.length) this.status(this.visual.warnings.join(' '), 'bad');
    this._updateHighlight();
  }

  // ---------------------------------------------------------------------------------
  showTab(tab) {
    this.tab = tab;
    this.pickMode = false;
    document.querySelectorAll('#garage-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.gtab === tab));
    const body = $('garage-body');
    body.innerHTML = '';
    const fn = { bikes: this._tabBikes, paint: this._tabPaint, import: this._tabImport, adjust: this._tabAdjust, parts: this._tabParts }[tab];
    fn.call(this, body);
    this._clearHighlight();
    if (tab === 'parts') this._updateHighlight();
  }

  _btn(label, onClick, cls = 'small') {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.setAttribute('data-nav', '');
    b.innerHTML = `<span>${label}</span>`;
    b.addEventListener('click', () => {
      this.game.audio.uiSelect();
      onClick();
    });
    return b;
  }

  _row(label, ctl) {
    const r = document.createElement('div');
    r.className = 'set-row';
    r.setAttribute('data-nav', '');
    r.tabIndex = -1;
    const l = document.createElement('label');
    l.textContent = label;
    r.appendChild(l);
    const c = document.createElement('div');
    c.className = 'ctl';
    c.appendChild(ctl);
    r.appendChild(c);
    return r;
  }

  _slider(min, max, step, value, fmt, onInput, log = false) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '8px';
    const r = document.createElement('input');
    r.type = 'range';
    r.tabIndex = -1;
    const toPos = (v) => (log ? Math.log10(Math.max(v, 1e-6)) : v);
    const fromPos = (p) => (log ? Math.pow(10, p) : p);
    r.min = min; r.max = max; r.step = step;
    r.value = toPos(value);
    r.style.width = '150px';
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = fmt(value);
    r.addEventListener('input', () => {
      const v = fromPos(parseFloat(r.value));
      val.textContent = fmt(v);
      onInput(v);
    });
    wrap.appendChild(r);
    wrap.appendChild(val);
    wrap._range = r;
    return wrap;
  }

  _withAdjust(row, sliderWrap) {
    const r = sliderWrap._range;
    row._adjust = (dir) => {
      r.value = parseFloat(r.value) + dir * parseFloat(r.step) * 2;
      r.dispatchEvent(new Event('input'));
    };
    return row;
  }

  // ---------------------------------------------------------------------------------
  _tabBikes(body) {
    const list = document.createElement('div');
    list.className = 'bike-list';
    const active = this.settings.game.activeBike;
    const mk = (id, name, meta) => {
      const it = document.createElement('div');
      it.className = 'bike-item' + (this.current && this.current.id === id ? ' on' : '');
      it.setAttribute('data-nav', '');
      it.tabIndex = -1;
      it.innerHTML = `<div><div class="bn">${esc(name)} ${active === id ? '<span class="badge">ACTIVE</span>' : ''}</div><div class="bm">${esc(meta)}</div></div>`;
      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '6px';
      btns.appendChild(this._btn('Use', () => this.setActive(id), 'small primary'));
      if (id !== 'procedural') {
        btns.appendChild(this._btn('Delete', async () => {
          const ok = await this.game.ui.modal('Delete bike', `Delete <b>${esc(name)}</b> from the garage? Its stored files will be removed.`, [{ label: 'Cancel', value: false }, { label: 'Delete', primary: true, value: true }]);
          if (!ok) return;
          await deleteBike(id);
          if (this.settings.game.activeBike === id) this.setActive('procedural');
          this.bikes = await listBikes().catch(() => []);
          if (this.current && this.current.id === id) this.showProcedural();
          this.showTab('bikes');
        }, 'small danger'));
      }
      it.appendChild(btns);
      it._activate = async () => {
        if (id === 'procedural') this.showProcedural();
        else await this.loadStored(id);
        this.showTab('bikes');
      };
      it.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        it._activate();
      });
      list.appendChild(it);
    };
    mk('procedural', 'Roost 450', 'Procedural · built in');
    for (const b of this.bikes) mk(b.id, b.name, `${b.format.toUpperCase()} · ${(b.size / 1048576).toFixed(1)} MB`);
    if (this.pending) {
      const p = document.createElement('div');
      p.className = 'note';
      p.style.margin = '8px 0';
      p.textContent = `Unsaved import: "${this.pending.name}" — save it in the Import tab.`;
      body.appendChild(p);
    }
    body.appendChild(list);
    const showRider = document.createElement('div');
    showRider.style.marginTop = '14px';
    const seg = this._seg([[true, 'Show'], [false, 'Hide']], !!(this.rider && this.rider.group.parent), (v) => this._attachRider(v));
    showRider.appendChild(this._row('Rider in preview', seg));
    body.appendChild(showRider);
    const hint = document.createElement('p');
    hint.className = 'note';
    hint.textContent = 'Import your own bike in the Import tab. GLB is recommended; GLTF, FBX, OBJ and ZIP/PKZ packages are inspected too.';
    body.appendChild(hint);
  }

  _seg(opts, cur, onSet) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    const btns = opts.map(([v, l]) => {
      const b = document.createElement('button');
      b.textContent = l;
      b.tabIndex = -1;
      b.classList.toggle('on', v === cur);
      b.onclick = () => {
        btns.forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onSet(v);
      };
      seg.appendChild(b);
      return b;
    });
    return seg;
  }

  async setActive(id) {
    this.settings.game.activeBike = id;
    saveSettings(this.settings);
    const name = id === 'procedural' ? 'Roost 450' : (this.bikes.find((b) => b.id === id) || {}).name || 'Custom bike';
    this.game.activeBikeName = id === 'procedural' ? 'Roost 450 (procedural)' : name + ' (imported)';
    this.game.ui.toast(`${name} is now your active bike`, 'good');
    if (!this.current || this.current.id !== id) {
      if (id === 'procedural') this.showProcedural();
      else await this.loadStored(id);
    }
    this.game.bikeDirty = true;
    this.showTab(this.tab);
  }

  // ---------------------------------------------------------------------------------
  _tabPaint(body) {
    const wrap = document.createElement('div');
    const sw = document.createElement('div');
    sw.className = 'swatches';
    const names = ['red', 'blue', 'green', 'black', 'white', 'orange', 'yellow'];
    for (const n of names) {
      const b = document.createElement('button');
      b.className = 'swatch' + (BIKE_COLORS[n] === this.settings.bike.color ? ' on' : '');
      b.style.background = BIKE_COLORS[n];
      b.title = n;
      b.onclick = () => this.setColor(BIKE_COLORS[n]);
      sw.appendChild(b);
    }
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = this.settings.bike.color;
    picker.title = 'Custom color';
    picker.addEventListener('input', () => this.setColor(picker.value, true));
    sw.appendChild(picker);
    wrap.appendChild(this._row('Bike color', sw));
    const num = document.createElement('input');
    num.type = 'text';
    num.maxLength = 3;
    num.style.width = '70px';
    num.value = this.settings.bike.number;
    num.addEventListener('change', () => {
      this.settings.bike.number = num.value.trim() || '27';
      saveSettings(this.settings);
      this.game.bikeDirty = true;
      if (this.current && this.current.id === 'procedural') this.showProcedural();
    });
    wrap.appendChild(this._row('Race number', num));
    body.appendChild(wrap);
    if (this.current && this.current.id !== 'procedural' && this.source) {
      const sec = document.createElement('div');
      sec.className = 'set-section';
      sec.textContent = 'Paintable materials (imported model)';
      body.appendChild(sec);
      const mats = listMaterials(this.source);
      const cfg = this.current.config;
      for (const m of mats) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = cfg.paint.includes(m);
        cb.addEventListener('change', () => {
          const set = new Set(cfg.paint);
          if (cb.checked) set.add(m);
          else set.delete(m);
          cfg.paint = [...set];
          this._rebuildImported();
          this._saveConfigQuiet();
        });
        body.appendChild(this._row(m, cb));
      }
      const n = document.createElement('p');
      n.className = 'note';
      n.textContent = 'Ticked materials take the bike color. The rider gear always uses the bike color.';
      body.appendChild(n);
    }
  }

  setColor(hex, keepPicker) {
    this.settings.bike.color = hex;
    saveSettings(this.settings);
    if (this.visual) this.visual.setColor(hex);
    if (this.rider) this.rider.setColor(hex);
    this.game.applySetting('bike.color', hex);
    if (!keepPicker) this.showTab('paint');
  }

  // ---------------------------------------------------------------------------------
  _tabImport(body) {
    const intro = document.createElement('div');
    intro.className = 'note';
    intro.innerHTML = 'Import a motocross bike model. <b>GLB is recommended.</b> GLTF (+ .bin/textures), FBX, OBJ (+ .mtl/textures) and ZIP/PKZ archives are supported. You can also drag files onto the window.';
    body.appendChild(intro);
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.glb,.gltf,.bin,.fbx,.obj,.mtl,.png,.jpg,.jpeg,.webp,.tga,.dds,.ktx2,.pkz,.zip';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      if (input.files.length) this.importFiles(input.files);
      input.value = '';
    });
    body.appendChild(input);
    const dz = document.createElement('div');
    dz.className = 'dropzone';
    dz.textContent = 'Drop .glb / .gltf / .fbx / .obj / .pkz / .zip here';
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    body.appendChild(dz);
    const choose = this._btn('Choose files…', () => input.click(), 'primary');
    body.appendChild(choose);
    if (this.pending) {
      const sec = document.createElement('div');
      sec.className = 'set-section';
      sec.textContent = 'Save imported bike';
      body.appendChild(sec);
      const name = document.createElement('input');
      name.type = 'text';
      name.value = this.pending.name;
      name.style.width = '200px';
      name.addEventListener('input', () => (this.pending.name = name.value));
      body.appendChild(this._row('Name', name));
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.style.marginTop = '8px';
      row.appendChild(this._btn('Save to garage', () => this.savePending(false), 'small'));
      row.appendChild(this._btn('Save & use', () => this.savePending(true), 'small primary'));
      body.appendChild(row);
    }
    if (this.lastReport) body.appendChild(this._renderReport(this.lastReport));
  }

  _renderReport(rep) {
    const d = document.createElement('div');
    d.className = 'report';
    let html = '<div class="set-section">Last import report</div>';
    for (const a of rep.archives) {
      html += `<div><b>${esc(a.name)}</b> — ${a.kind}, ${(a.size / 1048576).toFixed(2)} MB, ${a.isZip ? '<span class="ok">ZIP container</span>' : '<span class="bad">not a ZIP container</span>'}</div>`;
      if (a.error) html += `<div class="bad">${esc(a.error)}</div>`;
      if (a.entries.length) {
        html += '<div class="entries">' + a.entries.map((e) => `${e.kind === 'model' ? '✔' : e.kind === 'proprietary' ? '✖' : '·'} ${esc(e.path)} <span class="muted">(${(e.size / 1024).toFixed(0)} KB${e.note ? ', ' + esc(e.note) : ''})</span>`).join('<br>') + '</div>';
      }
    }
    if (rep.model) html += `<div class="ok">Model used: ${esc(rep.model)}</div>`;
    if (rep.warnings.length) html += '<ul>' + rep.warnings.map((w) => `<li class="${rep.ok ? '' : 'bad'}">${esc(w)}</li>`).join('') + '</ul>';
    if (rep.loadError) html += `<div class="bad">${esc(rep.loadError)}</div>`;
    if (!rep.ok || rep.proprietary.length) {
      html += '<div class="set-section">How to use a bike from a .pkz mod</div><ul>' + CONVERSION_GUIDE.map((g) => `<li>${esc(g)}</li>`).join('') + '</ul>';
    }
    if (rep.detect) html += `<div class="muted">Parts detected by ${rep.detect.method}. ${esc(rep.fitMessage || '')}</div>`;
    d.innerHTML = html;
    return d;
  }

  async importFiles(fileList) {
    try {
      this.status('Reading files…');
      const raw = await readFileList(fileList);
      const { files, report } = inspectFiles(raw);
      this.lastReport = report;
      if (!report.ok) {
        this.status('No loadable model found — see the import report.', 'bad');
        this.showTab('import');
        return;
      }
      this.status('Loading ' + report.model + '…');
      let loaded;
      try {
        loaded = await loadModel(files, report.model, this.renderer);
      } catch (err) {
        report.loadError = err.message;
        report.ok = false;
        this.status(err.message, 'bad');
        this.showTab('import');
        return;
      }
      report.warnings.push(...loaded.warnings);
      const det = autoDetect(loaded.root);
      const config = defaultConfig();
      config.comps = det.comps;
      const fit = autoFit(loaded.root, config.comps);
      config.scale = fit.scale;
      config.rot = fit.rot;
      config.pos = fit.pos;
      config.autoFitDone = fit.ok;
      if (loaded.animations.length) config.animation = '';
      report.detect = det;
      report.fitMessage = fit.message;
      // keep only files useful for this model (model, buffers, textures, materials)
      const keep = files.filter((f) => ['glb', 'gltf', 'bin', 'fbx', 'obj', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'tga', 'dds', 'ktx2', 'gif', 'bmp'].includes(fileExt(f.name)));
      if (this.source && !this.pending) releaseModel(this.source);
      else if (this.pending && this.pending.root) releaseModel(this.pending.root);
      this.source = loaded.root;
      const baseName = report.model.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      this.pending = { root: loaded.root, files: keep, main: report.model, name: baseName, format: fileExt(report.model), animations: loaded.animations };
      this.current = { id: null, name: baseName, format: this.pending.format, config, animations: loaded.animations, main: report.model };
      this._rebuildImported();
      const st = loaded.stats;
      this.status(`Loaded ${baseName}: ${st.meshes} meshes, ${st.triangles.toLocaleString()} triangles. ${fit.message}`, 'good');
      this.showTab('import');
    } catch (e) {
      console.error(e);
      this.status('Import failed: ' + e.message, 'bad');
    }
  }

  async savePending(use) {
    const p = this.pending;
    if (!p) return;
    const id = 'bike-' + Date.now().toString(36);
    try {
      await saveBike({ id, name: p.name || 'Custom bike', format: p.format, main: p.main, files: p.files, config: this.current.config, created: Date.now() });
    } catch (e) {
      this.status('Could not save: ' + e.message, 'bad');
      return;
    }
    this.game.cacheImportedSource(id, { root: p.root, animations: p.animations });
    this.current.id = id;
    this.current.name = p.name;
    this.pending = null;
    this.bikes = await listBikes().catch(() => []);
    this.game.ui.toast(`Saved "${p.name}" to the garage`, 'good');
    if (use) await this.setActive(id);
    else this.showTab('import');
  }

  async _saveConfigQuiet() {
    if (this.current && this.current.id && this.current.id !== 'procedural') {
      try {
        await updateBikeConfig(this.current.id, this.current.config);
        if (this.settings.game.activeBike === this.current.id) this.game.bikeDirty = true;
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------------
  _tabAdjust(body) {
    if (!this.current || this.current.id === 'procedural' || !this.source) {
      body.innerHTML = '<p class="note">The procedural bike is already fitted to the physics. Import a custom model to adjust its scale, position and rotation.</p>';
      return;
    }
    const cfg = this.current.config;
    const apply = () => {
      this.visual && this.visual.applyAdjust();
      this._rebuildSoon();
    };
    const add = (label, wrap) => body.appendChild(this._withAdjust(this._row(label, wrap), wrap));
    add('Scale', this._slider(-3, 2, 0.005, cfg.scale, (v) => v.toFixed(3), (v) => { cfg.scale = v; apply(); }, true));
    ['X', 'Y', 'Z'].forEach((ax, i) => add('Position ' + ax, this._slider(-2.5, 2.5, 0.005, cfg.pos[i], (v) => v.toFixed(2) + 'm', (v) => { cfg.pos[i] = v; apply(); })));
    ['X', 'Y', 'Z'].forEach((ax, i) => add('Rotation ' + ax, this._slider(-180, 180, 0.5, cfg.rot[i], (v) => v.toFixed(0) + '°', (v) => { cfg.rot[i] = v; apply(); })));
    const sec = document.createElement('div');
    sec.className = 'set-section';
    sec.textContent = 'Rider';
    body.appendChild(sec);
    body.appendChild(this._row('Show rider', this._seg([[true, 'On'], [false, 'Off']], cfg.rider.show, (v) => { cfg.rider.show = v; this._attachRider(v); this._saveConfigQuiet(); })));
    ['X', 'Y', 'Z'].forEach((ax, i) => add('Rider offset ' + ax, this._slider(-0.6, 0.6, 0.005, cfg.rider.offset[i], (v) => v.toFixed(2) + 'm', (v) => { cfg.rider.offset[i] = v; this._attachRider(cfg.rider.show); this._saveConfigQuiet(); })));
    if (this.current.animations && this.current.animations.length) {
      const sel = document.createElement('select');
      sel.innerHTML = '<option value="">None</option>' + this.current.animations.map((a) => `<option ${a.name === cfg.animation ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
      sel.addEventListener('change', () => { cfg.animation = sel.value; this._rebuildImported(); this._saveConfigQuiet(); });
      body.appendChild(this._row('Model animation', sel));
    }
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '8px';
    row.style.marginTop = '12px';
    row.appendChild(this._btn('Auto-fit to wheels', () => {
      const fit = autoFit(this.source, cfg.comps);
      cfg.scale = fit.scale; cfg.rot = fit.rot; cfg.pos = fit.pos;
      this._rebuildImported();
      this.status(fit.message, fit.ok ? 'good' : 'bad');
      this.showTab('adjust');
    }));
    row.appendChild(this._btn('Reset adjustments', () => {
      cfg.scale = 1; cfg.pos = [0, 0, 0]; cfg.rot = [0, 0, 0];
      this._rebuildImported();
      this.showTab('adjust');
    }));
    row.appendChild(this._btn('Save configuration', async () => {
      if (this.pending) return this.status('Save the bike in the Import tab first.', 'bad');
      await updateBikeConfig(this.current.id, cfg);
      if (this.settings.game.activeBike === this.current.id) this.game.bikeDirty = true;
      this.game.ui.toast('Configuration saved', 'good');
    }));
    row.appendChild(this._btn('Apply & use', async () => {
      if (this.pending) await this.savePending(true);
      else {
        await updateBikeConfig(this.current.id, cfg);
        await this.setActive(this.current.id);
      }
    }, 'small primary'));
    body.appendChild(row);
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = 'The grey wheels of the physics bike are at the orange turntable centre ±0.74 m. Use Preview motion in the Parts tab to check steering and suspension.';
    body.appendChild(n);
  }

  _rebuildSoon() {
    clearTimeout(this._rb);
    this._rb = setTimeout(() => {
      this._rebuildImported();
      this._saveConfigQuiet();
    }, 250);
  }

  // ---------------------------------------------------------------------------------
  _tabParts(body) {
    if (!this.current || this.current.id === 'procedural' || !this.source) {
      body.innerHTML = '<p class="note">Part assignment is used for imported models: tell the game which objects are the wheels, steering, fork and swingarm so they move with the physics.</p>';
      return;
    }
    const cfg = this.current.config;
    const nodes = listNodes(this.source);
    const nameOf = (p) => {
      const n = nodes.find((x) => x.path === p);
      return n ? n.name : p;
    };
    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.flexWrap = 'wrap';
    top.style.gap = '8px';
    top.appendChild(this._btn('Auto-detect', () => {
      const det = autoDetect(this.source);
      cfg.comps = det.comps;
      this._rebuildImported();
      this._saveConfigQuiet();
      this.status('Auto-detected by ' + det.method, 'good');
      this.showTab('parts');
    }));
    top.appendChild(this._btn('Swap wheels', () => {
      const t = cfg.comps.frontWheel;
      cfg.comps.frontWheel = cfg.comps.rearWheel;
      cfg.comps.rearWheel = t;
      this._rebuildImported();
      this._saveConfigQuiet();
      this.showTab('parts');
    }));
    top.appendChild(this._btn(this.preview ? 'Stop preview' : 'Preview motion', () => {
      this.preview = !this.preview;
      this.showTab('parts');
    }));
    body.appendChild(top);
    for (const slot of COMPONENT_SLOTS) {
      const r = document.createElement('div');
      r.className = 'parts-row';
      const list = cfg.comps[slot.key] || [];
      r.innerHTML = `<div class="pl"><span>${slot.label}</span><span class="muted small">${list.length ? list.length + ' object(s)' : 'not set'}</span></div><div class="pv">${list.map((p) => esc(nameOf(p))).join(', ') || '—'}</div>`;
      const pb = document.createElement('div');
      pb.className = 'pb';
      const active = this.activeSlot === slot.key;
      pb.appendChild(this._btn(active ? 'Click the model…' : 'Pick in 3D', () => {
        this.activeSlot = slot.key;
        this.pickMode = true;
        this.status(`Click a part of the model to ${slot.multi ? 'add it to' : 'set'} "${slot.label}". Click again to remove.`);
        this.showTab('parts');
        this.pickMode = true;
      }, 'small' + (active ? ' primary' : '')));
      pb.appendChild(this._btn('Select', () => {
        this.activeSlot = slot.key;
        this.showTab('parts');
      }));
      pb.appendChild(this._btn('Clear', () => {
        cfg.comps[slot.key] = [];
        this._rebuildImported();
        this._saveConfigQuiet();
        this.showTab('parts');
      }));
      r.appendChild(pb);
      if (active) {
        const nl = document.createElement('div');
        nl.className = 'node-list';
        for (const n of nodes) {
          const d = document.createElement('div');
          d.style.paddingLeft = 8 + n.depth * 12 + 'px';
          d.textContent = `${n.isMesh ? '▪' : '▸'} ${n.name}${n.tris ? ' (' + n.tris + ' tris)' : ''}`;
          d.classList.toggle('sel', list.includes(n.path));
          d.addEventListener('click', () => this._toggleAssign(slot, n.path));
          d.addEventListener('mouseenter', () => this._highlightPaths([n.path], 0x3ccf6e));
          d.addEventListener('mouseleave', () => this._updateHighlight());
          nl.appendChild(d);
        }
        r.appendChild(nl);
      }
      body.appendChild(r);
    }
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = 'Steering assembly and handlebar rotate around the steering axis, the fork slides with front travel, the swingarm pivots with rear travel and both wheels spin. Changes are saved automatically for stored bikes.';
    body.appendChild(n);
    this.pickMode = !!this.activeSlot && this.pickMode;
  }

  _toggleAssign(slot, path) {
    const cfg = this.current.config;
    let list = cfg.comps[slot.key] || [];
    if (list.includes(path)) list = list.filter((p) => p !== path);
    else list = slot.multi ? [...list, path] : [path];
    cfg.comps[slot.key] = list;
    this._rebuildImported();
    this._saveConfigQuiet();
    this.showTab('parts');
  }

  _pick(e) {
    if (!this.visual || this.visual.kind !== 'imported' || !this.activeSlot) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.visual.root, true).filter((h) => h.object.isMesh && !(this.rider && isDesc(h.object, this.rider.group)));
    if (!hits.length) return this.status('Nothing there — click directly on the model.');
    // map the clicked (re-parented clone) mesh back to the source by name path inside the clone
    const obj = hits[0].object;
    const path = this._sourcePathFor(obj);
    if (path == null) return this.status('Could not identify that part.', 'bad');
    const slot = COMPONENT_SLOTS.find((s) => s.key === this.activeSlot);
    this._toggleAssign(slot, path);
    this.status(`${slot.label}: toggled "${obj.name || 'mesh'}"`, 'good');
    this.pickMode = true;
  }

  _sourcePathFor(obj) {
    // the visual is a clone; the clone keeps userData.srcPath set at bind time
    let n = obj;
    while (n && n.userData.srcPath === undefined) n = n.parent;
    return n ? n.userData.srcPath : null;
  }

  _clearHighlight() {
    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.geometry.dispose();
      this.highlight = null;
    }
  }

  _highlightPaths(paths, color = 0xffd400) {
    this._clearHighlight();
    if (!paths.length || !this.visual || this.visual.kind !== 'imported') return;
    const box = new THREE.Box3();
    this.visual.root.updateMatrixWorld(true);
    this.visual.root.traverse((o) => {
      if (o.userData.srcPath !== undefined && paths.includes(o.userData.srcPath)) box.union(new THREE.Box3().setFromObject(o));
    });
    if (box.isEmpty()) return;
    this.highlight = new THREE.Box3Helper(box, color);
    this.scene.add(this.highlight);
  }

  _updateHighlight() {
    if (this.tab !== 'parts' || !this.activeSlot || !this.current || !this.current.config) return this._clearHighlight();
    this._highlightPaths(this.current.config.comps[this.activeSlot] || []);
  }

  // ---------------------------------------------------------------------------------
  update(dt) {
    this.t += dt;
    if (this.controls) this.controls.update(dt);
    if (this.visual) {
      const p = this.preview;
      const steer = p ? Math.sin(this.t * 1.6) * 0.45 : 0;
      const comp = p ? 0.5 + 0.5 * Math.sin(this.t * 2.4) : 0;
      this.visual.update({
        steer,
        compF: GEO.sagF + (p ? (comp - 0.25) * 0.2 : 0),
        compR: GEO.sagR + (p ? (comp - 0.25) * 0.2 : 0),
        spinF: p ? this.t * 6 : 0,
        spinR: p ? this.t * 6 : 0,
      }, dt);
      if (this.rider && this.rider.group.parent) this._poseRider(steer);
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

function isDesc(o, anc) {
  while (o) {
    if (o === anc) return true;
    o = o.parent;
  }
  return false;
}
