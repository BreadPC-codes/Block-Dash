// HTML user interface: menus, settings, track select, HUD, minimap, notifications.
import { ACTIONS, ACTION_LABELS, DEFAULT_KEYS, DEFAULT_PAD, keyLabel, padLabel, saveSettings } from './settings.js';
import { BIKE_COLORS } from './bike.js';
import { formatTime, formatDelta, clamp } from './util.js';
import { TRACKS } from './tracks.js';
import { Track } from './track.js';

const $ = (id) => document.getElementById(id);
const pct = (v) => Math.round(v * 100) + '%';
const num = (v) => v.toFixed(2);

const TIPS = [
  'Lean the rider forward (↑ / left stick up) on the takeoff to keep the front end down.',
  'Counter-lean to turn faster: lean the rider (← → / right stick) to the OUTSIDE of the turn while the bike leans in. More grip, tighter line.',
  'Throw the rider\'s body left or right in the air (← → / right stick) to tilt the bike for a scrub.',
  'Every key and controller button can be remapped in Settings > Controls.',
  'Dynamic resolution (Settings > Graphics) keeps the game at 60 FPS on slower computers.',
  'Throttle in the air lifts the nose; tapping the rear brake drops it.',
  'Steer in the air (A / D, left stick) to whip the bike: a tap is a tweak, holding it throws it sideways. Let go early enough to straighten it before you land!',
  'Start a whip on the last metres of the jump face and the bike leaves the lip already turning.',
  'Press F3 to see the whip physics: angles, rotation speeds, torques and your inputs.',
  'The rear brake (S) helps you slide the bike around tight corners.',
  'Berms let you lean deeper and carry more speed through turns.',
  'Sand has less grip and much more drag: keep the throttle on.',
  'Land with the wheels matching the slope of the landing for a smooth touchdown.',
  'Press C to change the camera, B to look behind you, R to reset.',
];

export const SETTINGS_SCHEMA = {
  bike: [
    { section: 'Handling' },
    { type: 'range', path: 'bike.steerSens', label: 'Steering sensitivity', min: 0.5, max: 1.5, step: 0.05, fmt: pct },
    { type: 'range', path: 'bike.enginePower', label: 'Engine power', min: 0.6, max: 1.4, step: 0.05, fmt: pct },
    { type: 'range', path: 'bike.suspStiffness', label: 'Suspension stiffness', min: 0.6, max: 1.5, step: 0.05, fmt: pct },
    { type: 'range', path: 'bike.suspDamping', label: 'Suspension damping', min: 0.5, max: 1.6, step: 0.05, fmt: pct },
    { type: 'range', path: 'bike.brakeFront', label: 'Front brake strength', min: 0.4, max: 1.4, step: 0.05, fmt: pct },
    { type: 'range', path: 'bike.brakeRear', label: 'Rear brake strength', min: 0.4, max: 1.4, step: 0.05, fmt: pct },
    { type: 'range', path: 'bike.grip', label: 'Tire grip', min: 0.6, max: 1.6, step: 0.05, fmt: pct },
    { type: 'range', path: 'bike.airControl', label: 'Air control (whips)', min: 0.5, max: 1.5, step: 0.05, fmt: pct },
    { type: 'seg', path: 'bike.assist', label: 'Rider assists', options: [[0, 'Off'], [1, 'Low'], [2, 'Full']] },
    { type: 'seg', path: 'bike.autoGearbox', label: 'Gearbox', options: [[true, 'Auto'], [false, 'Manual']] },
    { section: 'Camera & controller' },
    { type: 'range', path: 'camera.sensitivity', label: 'Camera sensitivity', min: 0.3, max: 2, step: 0.05, fmt: pct },
    { type: 'range', path: 'camera.distance', label: 'Camera distance', min: 0.7, max: 1.6, step: 0.05, fmt: pct },
    { type: 'range', path: 'controls.padSteerSens', label: 'Controller sensitivity', min: 0.5, max: 1.5, step: 0.05, fmt: pct },
    { section: 'Look' },
    { type: 'color', path: 'bike.color', label: 'Bike color' },
    { type: 'text', path: 'bike.number', label: 'Race number', maxLength: 3 },
  ],
  controls: [
    { section: 'Controller options' },
    { type: 'range', path: 'controls.padDeadzone', label: 'Stick deadzone', min: 0.02, max: 0.35, step: 0.01, fmt: num },
    { type: 'range', path: 'controls.padSteerSens', label: 'Steering sensitivity', min: 0.5, max: 1.5, step: 0.05, fmt: pct },
    { type: 'toggle', path: 'controls.invertLean', label: 'Invert rider forward / back' },
    { type: 'toggle', path: 'controls.linkedBrakes', label: 'Front brake also uses some rear brake' },
  ],
  graphics: [
    { section: 'Display' },
    { type: 'seg', path: 'graphics.quality', label: 'Quality preset', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
    { type: 'range', path: 'graphics.renderScale', label: 'Render scale', min: 0.5, max: 1, step: 0.05, fmt: pct },
    { type: 'toggle', path: 'graphics.dynamicRes', label: 'Dynamic resolution (holds 60 FPS)' },
    { type: 'seg', path: 'graphics.antialias', label: 'Anti-aliasing', options: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']] },
    { type: 'toggle', path: 'graphics.fullscreen', label: 'Fullscreen' },
    { type: 'seg', path: 'graphics.units', label: 'Speed units', options: [['kmh', 'KM/H'], ['mph', 'MPH']] },
    { type: 'toggle', path: 'graphics.minimap', label: 'Minimap' },
    { type: 'toggle', path: 'graphics.freeRideTimer', label: 'Lap timer in Free Ride' },
    { type: 'toggle', path: 'graphics.showFps', label: 'Show FPS' },
    { type: 'toggle', path: 'graphics.physicsDebug', label: 'Physics debug overlay (F3)' },
  ],
  audio: [
    { section: 'Volume' },
    { type: 'range', path: 'audio.master', label: 'Master volume', min: 0, max: 1, step: 0.05, fmt: pct },
    { type: 'range', path: 'audio.engine', label: 'Engine volume', min: 0, max: 1, step: 0.05, fmt: pct },
    { type: 'range', path: 'audio.effects', label: 'Effects volume', min: 0, max: 1, step: 0.05, fmt: pct },
  ],
};

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function setPath(obj, path, val) {
  const ks = path.split('.');
  const last = ks.pop();
  const o = ks.reduce((a, k) => a[k], obj);
  o[last] = val;
}

export class UI {
  constructor(game) {
    this.game = game;
    this.settings = game.settings;
    this.screen = 'loading';
    this.history = [];
    this.focusEl = null;
    this.settingsTab = 'bike';
    this.hudCache = {};
    this.toastsEl = $('toasts');
    this.listening = null;
    this._bindStatic();
    this._buildRpm();
    $('loading-tip').textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  }

  // ---------------------------------------------------------------------------------
  _bindStatic() {
    document.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', () => this.action(el.dataset.action, el));
    });
    document.querySelectorAll('[data-mode]').forEach((el) => {
      el.addEventListener('click', () => {
        this.settings.game.mode = el.dataset.mode;
        saveSettings(this.settings);
        this.refreshMenuCard();
        this.game.audio.uiSelect();
      });
      el.addEventListener('dblclick', () => this.action('ride'));
    });
    document.querySelectorAll('#settings-tabs .tab').forEach((el) => {
      el.addEventListener('click', () => this.showSettingsTab(el.dataset.tab));
    });
    // focus follows the mouse
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest && e.target.closest('[data-nav]');
      if (t && t !== this.focusEl && this._isVisible(t)) {
        this.setFocus(t, true);
      }
    });
  }

  action(name, el) {
    const g = this.game;
    if (name !== 'back') g.audio.uiSelect();
    else g.audio.uiBack();
    if (name === 'back') return this.back();
    if (name.startsWith('settings:')) {
      let tab = name.split(':')[1];
      if (tab === 'last') tab = this.settingsTab;
      this.go('settings');
      this.showSettingsTab(tab);
      return;
    }
    switch (name) {
      case 'play': this.go('play'); break;
      case 'tracks': this.go('tracks'); break;
      case 'garage': g.openGarage(); break;
      case 'quit': g.quit(); break;
      case 'ride': g.startRide(); break;
      case 'resume': g.resume(); break;
      case 'restart': g.restartSession(); break;
      case 'mainmenu': g.toMainMenu(); break;
      case 'garage-ride': g.closeGarage(true); break;
      default: break;
    }
    void el;
  }

  // ---------------------------------------------------------------------------------
  go(screen, { push = true } = {}) {
    if (push && this.screen && this.screen !== screen && !['loading'].includes(this.screen)) this.history.push(this.screen);
    this.show(screen);
  }

  show(screen) {
    this.screen = screen;
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + screen));
    const menuish = ['main', 'play', 'tracks', 'settings'].includes(screen);
    $('shade').className = screen === 'main' ? 'on' : menuish || screen === 'pause' ? 'full' : '';
    if (screen === 'loading') $('shade').className = 'full';
    if (screen === 'play') this._refreshPlay();
    if (screen === 'tracks') this.buildTrackCards();
    if (screen === 'main') this.refreshMenuCard();
    // initial focus
    const first = this._focusables()[0];
    this.focusEl = null;
    if (first) this.setFocus(first, true);
    this.game.input.blockDefaults = screen === 'ride';
  }

  back() {
    if (this.listening) return;
    if (this.screen === 'pause') return this.game.resume();
    if (this.screen === 'garage') return this.game.closeGarage(false);
    if (this.screen === 'settings' || this.screen === 'tracks' || this.screen === 'play') {
      const prev = this.history.pop() || (this.game.state === 'paused' ? 'pause' : 'main');
      this.show(prev);
      return;
    }
  }

  hideMenus() {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $('shade').className = '';
    this.screen = 'ride';
    this.history = [];
    this.game.input.blockDefaults = true;
  }

  // ---------------------------------------------------------------------------------
  setLoading(p, text) {
    $('loading-fill').style.width = Math.round(p * 100) + '%';
    if (text) $('loading-text').textContent = text;
  }

  toast(text, kind = '', ms = 3200) {
    const d = document.createElement('div');
    d.className = 'toast ' + kind;
    d.textContent = text;
    this.toastsEl.appendChild(d);
    setTimeout(() => {
      d.style.transition = 'opacity .4s';
      d.style.opacity = '0';
      setTimeout(() => d.remove(), 450);
    }, ms);
  }

  notify(text, small = '', cls = '', ms = 1600) {
    const c = $('hud-center');
    c.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'notice ' + cls;
    d.textContent = text;
    if (small) {
      const s = document.createElement('small');
      s.textContent = small;
      d.appendChild(s);
    }
    c.appendChild(d);
    clearTimeout(this._notifyT);
    if (ms > 0) this._notifyT = setTimeout(() => { if (d.parentNode) d.remove(); }, ms);
  }

  clearNotify() {
    $('hud-center').innerHTML = '';
  }

  modal(title, html, buttons = [{ label: 'OK', primary: true }]) {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      const body = $('modal-body');
      if (typeof html === 'string') body.innerHTML = html;
      else { body.innerHTML = ''; body.appendChild(html); }
      const bt = $('modal-btns');
      bt.innerHTML = '';
      buttons.forEach((b, i) => {
        const e = document.createElement('button');
        e.className = 'btn' + (b.primary ? ' primary' : ' ghost');
        e.setAttribute('data-nav', '');
        e.innerHTML = `<span>${b.label}</span>`;
        e.onclick = () => {
          $('modal').classList.add('hidden');
          this._modalOpen = false;
          resolve(b.value !== undefined ? b.value : i);
        };
        bt.appendChild(e);
      });
      $('modal').classList.remove('hidden');
      this._modalOpen = true;
      const f = bt.querySelector('.primary') || bt.firstChild;
      if (f) this.setFocus(f, true);
    });
  }

  // ---------------------------------------------------------------------------------
  refreshMenuCard() {
    const g = this.game;
    const def = TRACKS.find((t) => t.id === this.settings.game.track) || TRACKS[0];
    $('card-track').textContent = def.name;
    $('card-mode').textContent = this.settings.game.mode === 'trial' ? 'Time Trial' : 'Free Ride';
    $('card-bike').textContent = g.activeBikeName || 'Roost 450 (procedural)';
    const rec = g.records[def.id];
    $('card-best').textContent = rec ? formatTime(rec.best) : '--:--.---';
    $('build-info').textContent = (window.roostNative ? 'Desktop' : 'Browser') + ' · v1.0';
  }

  _refreshPlay() {
    const def = TRACKS.find((t) => t.id === this.settings.game.track) || TRACKS[0];
    $('play-track').textContent = def.name;
    const rec = this.game.records[def.id];
    $('play-best').textContent = rec ? formatTime(rec.best) : '--:--.---';
    document.querySelectorAll('[data-mode]').forEach((el) => el.classList.toggle('selected', el.dataset.mode === this.settings.game.mode));
  }

  setPadStatus(name) {
    const el = $('pad-status');
    el.textContent = name ? 'Controller: ' + name : 'No controller';
    el.classList.toggle('on', !!name);
  }

  // ---------------------------------------------------------------------------------
  buildTrackCards() {
    const grid = $('track-grid');
    grid.innerHTML = '';
    for (const def of TRACKS) {
      const b = document.createElement('button');
      b.className = 'track-card' + (def.id === this.settings.game.track ? ' selected' : '');
      b.setAttribute('data-nav', '');
      const cv = document.createElement('canvas');
      cv.width = 360;
      cv.height = 220;
      b.appendChild(cv);
      let tr = this._trackCache && this._trackCache[def.id];
      if (!tr) {
        tr = new Track(def);
        this._trackCache = this._trackCache || {};
        this._trackCache[def.id] = tr;
      }
      drawTrackPreview(cv, tr);
      const rec = this.game.records[def.id];
      const info = document.createElement('div');
      info.className = 'track-info';
      const jumps = tr.features.filter((f) => ['double', 'table', 'stepup', 'stepdown'].includes(f.type)).length;
      info.innerHTML = `<div class="track-kind">${def.kind}</div><div class="track-name">${def.name}</div><div class="track-desc">${def.description}</div>
        <div class="track-stats"><span>Length <b>${(tr.length / 1000).toFixed(2)} km</b></span><span>Jumps <b>${jumps}</b></span><span>Best <b>${rec ? formatTime(rec.best) : '—'}</b></span></div>`;
      b.appendChild(info);
      b.addEventListener('click', () => {
        this.game.audio.uiSelect();
        this.game.selectTrack(def.id);
      });
      grid.appendChild(b);
    }
  }

  // ---------------------------------------------------------------------------------
  showSettingsTab(tab) {
    this.settingsTab = tab;
    document.querySelectorAll('#settings-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    const body = $('settings-body');
    body.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'set-grid';
    body.appendChild(grid);
    if (tab === 'controls') this._buildKeys(body);
    for (const item of SETTINGS_SCHEMA[tab]) grid.appendChild(this._settingRow(item));
    if (tab === 'graphics') {
      const n = document.createElement('div');
      n.className = 'note';
      n.style.gridColumn = '1 / -1';
      n.style.marginTop = '12px';
      n.innerHTML = '<b>Low</b>: no shadows, 75% render scale, no grass, sparse trees, no anti-aliasing. <b>Medium</b>: 1K shadows, full render scale, some grass. <b>High</b>: 2K soft shadows, up to 1.5× render scale on high-DPI screens, dense grass and forests, full detail terrain near the track.<br><b>Dynamic resolution</b> lowers the render resolution only while the frame rate is below 60 FPS (or your screen\'s refresh rate) and raises it again when there is headroom. <b>Render scale</b> sets the maximum. Anti-aliasing changes apply after a restart. Press F11 (or Alt+Enter) to toggle fullscreen at any time.';
      grid.appendChild(n);
    }
    if (tab === 'controls') {
      const n = document.createElement('div');
      n.className = 'note';
      n.style.gridColumn = '1 / -1';
      n.style.marginTop = '10px';
      n.innerHTML = 'Bike and rider are controlled separately: <b>steering</b> turns and leans the bike, <b>rider lean</b> moves the rider\'s body. <b>Counter-lean to turn faster</b>: lean the rider to the outside of the turn (opposite to the bike) for more grip and a tighter line. Forward/back moves weight for wheelies, braking and pitch in the air; left/right also tilts the bike in the air.<br>Menus always use the d-pad / left stick to move, A to select, B to go back. Free camera: drag with the mouse, scroll to move, I/J/K/L to fly, U/O down/up, Shift for speed.';
      grid.appendChild(n);
    }
    const f = this._focusables();
    const firstRow = f.find((e) => !e.classList.contains('tab')) || f[0];
    const keep = this._refocus && document.querySelector(`[data-bind="${this._refocus}"]`);
    this._refocus = null;
    if (keep) this.setFocus(keep, true);
    else if (firstRow) this.setFocus(document.querySelector('#settings-tabs .tab.active') || firstRow, true);
  }

  _settingRow(item) {
    if (item.section) {
      const s = document.createElement('div');
      s.className = 'set-section';
      s.textContent = item.section;
      return s;
    }
    const row = document.createElement('div');
    row.className = 'set-row';
    row.setAttribute('data-nav', '');
    row.tabIndex = -1;
    const label = document.createElement('label');
    label.textContent = item.label;
    row.appendChild(label);
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    row.appendChild(ctl);
    const cur = getPath(this.settings, item.path);
    const commit = (v) => {
      setPath(this.settings, item.path, v);
      saveSettings(this.settings);
      this.game.applySetting(item.path, v);
    };
    if (item.type === 'range') {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = item.min; r.max = item.max; r.step = item.step;
      r.value = cur;
      r.tabIndex = -1;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = item.fmt(cur);
      r.addEventListener('input', () => {
        const v = parseFloat(r.value);
        val.textContent = item.fmt(v);
        commit(v);
      });
      ctl.appendChild(r);
      ctl.appendChild(val);
      row._adjust = (dir) => {
        const v = clamp(parseFloat(r.value) + dir * item.step, item.min, item.max);
        r.value = v;
        r.dispatchEvent(new Event('input'));
      };
    } else if (item.type === 'seg' || item.type === 'toggle') {
      const opts = item.type === 'toggle' ? [[false, 'Off'], [true, 'On']] : item.options;
      const seg = document.createElement('div');
      seg.className = 'seg';
      const btns = opts.map(([v, l]) => {
        const b = document.createElement('button');
        b.textContent = l;
        b.tabIndex = -1;
        b.classList.toggle('on', v === cur);
        b.addEventListener('click', () => {
          btns.forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          commit(v);
          this.game.audio.uiHover();
        });
        seg.appendChild(b);
        return b;
      });
      ctl.appendChild(seg);
      row._adjust = (dir) => {
        const i = opts.findIndex(([v]) => v === getPath(this.settings, item.path));
        const j = clamp(i + dir, 0, opts.length - 1);
        if (j !== i) btns[j].click();
      };
      row._activate = () => {
        const i = opts.findIndex(([v]) => v === getPath(this.settings, item.path));
        btns[(i + 1) % opts.length].click();
      };
    } else if (item.type === 'color') {
      const sw = document.createElement('div');
      sw.className = 'swatches';
      const names = ['red', 'blue', 'green', 'black', 'white', 'orange', 'yellow'];
      const all = [];
      for (const n of names) {
        const b = document.createElement('button');
        b.className = 'swatch';
        b.title = n;
        b.style.background = BIKE_COLORS[n];
        b.tabIndex = -1;
        b.classList.toggle('on', BIKE_COLORS[n].toLowerCase() === String(cur).toLowerCase());
        b.addEventListener('click', () => {
          all.forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          picker.value = BIKE_COLORS[n];
          commit(BIKE_COLORS[n]);
        });
        sw.appendChild(b);
        all.push(b);
      }
      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = cur;
      picker.tabIndex = -1;
      picker.title = 'Custom color';
      picker.addEventListener('input', () => {
        all.forEach((x) => x.classList.remove('on'));
        commit(picker.value);
      });
      sw.appendChild(picker);
      ctl.appendChild(sw);
      row._adjust = (dir) => {
        let i = all.findIndex((x) => x.classList.contains('on'));
        i = (i + dir + all.length) % all.length;
        all[i].click();
      };
    } else if (item.type === 'text') {
      const t = document.createElement('input');
      t.type = 'text';
      t.maxLength = item.maxLength || 12;
      t.value = cur;
      t.style.width = '70px';
      t.addEventListener('change', () => commit(t.value.trim() || '27'));
      ctl.appendChild(t);
      row._activate = () => t.focus();
    }
    return row;
  }

  _buildKeys(body) {
    const wrap = document.createElement('div');
    const pad = this.game.input.pad;
    const head = document.createElement('div');
    head.className = 'set-section';
    head.textContent = 'Button mapping';
    wrap.appendChild(head);
    const info = document.createElement('div');
    info.className = 'note';
    info.style.marginBottom = '8px';
    info.innerHTML = (pad.connected ? `Controller: <b>${(pad.id || 'Gamepad').replace(/\(.*?\)/g, '').trim().slice(0, 48)}</b>. ` : 'No controller detected — connect one and press any button on it. ')
      + 'Click a slot (or press A on it), then press the key / button or move the stick. Right-click, Delete or X clears a slot. Esc cancels.';
    wrap.appendChild(info);
    const table = document.createElement('table');
    table.className = 'keytable';
    table.innerHTML = '<tr><th>Action</th><th>Key</th><th>Alt key</th><th>Controller</th><th>Alt</th></tr>';
    const keys = this.settings.controls.keys;
    const pb = this.settings.controls.pad;
    const std = pad.standard !== false;
    for (const action of ACTIONS) {
      const tr = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.textContent = ACTION_LABELS[action];
      tr.appendChild(td0);
      for (const dev of ['key', 'pad']) {
        for (let slot = 0; slot < 2; slot++) {
          const td = document.createElement('td');
          if (dev === 'key' && action === 'pause') {
            if (slot === 0) {
              const fixed = document.createElement('span');
              fixed.className = 'keyfixed';
              fixed.textContent = 'Esc';
              td.appendChild(fixed);
            }
            tr.appendChild(td);
            continue;
          }
          const b = document.createElement('button');
          b.className = 'keybtn' + (dev === 'pad' ? ' padbtn' : '');
          b.setAttribute('data-nav', '');
          b.setAttribute('data-bind', `${dev}:${action}:${slot}`);
          const table_ = dev === 'key' ? keys : pb;
          const label = () => (dev === 'key' ? keyLabel(table_[action][slot]) : padLabel(table_[action][slot], std));
          b.textContent = label();
          b.addEventListener('click', () => (dev === 'key' ? this._listenKey(b, action, slot) : this._listenPad(b, action, slot)));
          b._clear = () => {
            table_[action][slot] = '';
            b.textContent = label();
            saveSettings(this.settings);
          };
          b.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            b._clear();
          });
          td.appendChild(b);
          tr.appendChild(td);
        }
      }
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    const btns = document.createElement('div');
    btns.className = 'row-btns';
    btns.style.justifyContent = 'flex-start';
    const mk = (text, fn) => {
      const r = document.createElement('button');
      r.className = 'btn small';
      r.setAttribute('data-nav', '');
      r.innerHTML = `<span>${text}</span>`;
      r.addEventListener('click', fn);
      btns.appendChild(r);
    };
    mk('Reset keyboard', () => {
      this.settings.controls.keys = JSON.parse(JSON.stringify(DEFAULT_KEYS));
      saveSettings(this.settings);
      this.showSettingsTab('controls');
      this.toast('Keyboard controls reset', 'good');
    });
    mk('Reset controller', () => {
      this.settings.controls.pad = JSON.parse(JSON.stringify(DEFAULT_PAD));
      saveSettings(this.settings);
      this.showSettingsTab('controls');
      this.toast('Controller buttons reset', 'good');
    });
    wrap.appendChild(btns);
    body.appendChild(wrap);
  }

  _listenKey(btn, action, slot) {
    if (this.listening) return;
    this.listening = btn;
    btn.classList.add('listening');
    btn.textContent = 'Press a key…';
    this.game.input.captureCallback = (code) => {
      btn.classList.remove('listening');
      this.listening = null;
      if (code === 'Escape') {
        btn.textContent = keyLabel(this.settings.controls.keys[action][slot]);
        return;
      }
      // remove the key from any other action to avoid conflicts
      const keys = this.settings.controls.keys;
      for (const a of Object.keys(keys)) for (let s = 0; s < 2; s++) if (keys[a][s] === code) keys[a][s] = '';
      keys[action][slot] = code;
      saveSettings(this.settings);
      this._refocus = `key:${action}:${slot}`;
      this.showSettingsTab('controls');
    };
  }

  _listenPad(btn, action, slot) {
    if (this.listening) return;
    const pad = this.game.input.pad;
    if (!pad.connected) {
      this.toast('Connect a controller and press any button on it first', 'bad');
      return;
    }
    this.listening = btn;
    btn.classList.add('listening');
    btn.textContent = 'Press…';
    const P = this.settings.controls.pad;
    pad.captureNext((code) => {
      btn.classList.remove('listening');
      this.listening = null;
      if (!code) {
        btn.textContent = padLabel(P[action][slot], pad.standard !== false);
        return;
      }
      for (const a of Object.keys(P)) for (let s = 0; s < 2; s++) if (P[a][s] === code) P[a][s] = '';
      P[action][slot] = code;
      saveSettings(this.settings);
      this.game.audio.uiSelect();
      this._refocus = `pad:${action}:${slot}`;
      this.showSettingsTab('controls');
    });
  }

  // ---------------------------------------------------------------------------------
  // Menu navigation (keyboard arrows / gamepad)
  _isVisible(el) {
    if (this._modalOpen) return !!el.closest('#modal');
    const scr = el.closest('.screen');
    return scr && scr.classList.contains('active') && el.offsetParent !== null;
  }

  _focusables() {
    const root = this._modalOpen ? $('modal') : document.querySelector('.screen.active');
    if (!root) return [];
    return Array.from(root.querySelectorAll('[data-nav]')).filter((e) => e.offsetParent !== null && !e.disabled);
  }

  setFocus(el, silent) {
    if (this.focusEl) this.focusEl.classList.remove('focus');
    this.focusEl = el;
    if (el) {
      el.classList.add('focus');
      if (el.focus) el.focus({ preventScroll: true });
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      if (!silent) this.game.audio.uiHover();
    }
  }

  navigate(dir) {
    if (this.listening) return;
    const list = this._focusables();
    if (!list.length) return;
    let cur = this.focusEl && list.includes(this.focusEl) ? this.focusEl : null;
    if (!cur) return this.setFocus(list[0]);
    if ((dir === 'left' || dir === 'right') && cur._adjust) {
      cur._adjust(dir === 'left' ? -1 : 1);
      return;
    }
    if ((dir === 'left' || dir === 'right') && cur.classList.contains('tab')) {
      const tabs = Array.from(cur.parentNode.querySelectorAll('.tab'));
      const i = tabs.indexOf(cur);
      const n = tabs[clamp(i + (dir === 'left' ? -1 : 1), 0, tabs.length - 1)];
      if (n !== cur) {
        n.click();
        this.setFocus(n);
      }
      return;
    }
    // spatial navigation: pick nearest element in the direction
    const r0 = cur.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const dx = x - cx, dy = y - cy;
      let ok = false, primary = 0, secondary = 0;
      if (dir === 'down') { ok = dy > 4; primary = dy; secondary = Math.abs(dx); }
      if (dir === 'up') { ok = dy < -4; primary = -dy; secondary = Math.abs(dx); }
      if (dir === 'right') { ok = dx > 4; primary = dx; secondary = Math.abs(dy); }
      if (dir === 'left') { ok = dx < -4; primary = -dx; secondary = Math.abs(dy); }
      if (!ok) continue;
      const score = primary + secondary * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) this.setFocus(best);
  }

  activate() {
    const el = this.focusEl;
    if (!el || !this._isVisible(el)) return;
    if (el._activate) return el._activate();
    el.click();
  }

  // ---------------------------------------------------------------------------------
  // HUD
  _buildRpm() {
    const r = $('hud-rpm');
    r.innerHTML = '';
    this.rpmBars = [];
    for (let i = 0; i < 24; i++) {
      const b = document.createElement('i');
      if (i >= 18) b.className = 'hot';
      if (i >= 21) b.className = 'red';
      r.appendChild(b);
      this.rpmBars.push(b);
    }
  }

  showHud(on) {
    $('hud').classList.toggle('hidden', !on);
  }

  _set(id, text) {
    if (this.hudCache[id] !== text) {
      this.hudCache[id] = text;
      $(id).textContent = text;
    }
  }

  updateHud(h) {
    const mph = this.settings.graphics.units === 'mph';
    const speed = Math.round(Math.abs(h.speed) * (mph ? 2.23694 : 3.6));
    this._set('hud-speed', String(speed));
    this._set('hud-units', mph ? 'MPH' : 'KM/H');
    this._set('hud-gear', String(h.gear));
    this._set('hud-gearbox', h.auto ? 'AUTO' : 'MANUAL');
    const lit = Math.round(clamp((h.rpm - 1500) / (12200 - 1500), 0, 1) * this.rpmBars.length);
    if (this.hudCache.rpm !== lit) {
      this.hudCache.rpm = lit;
      this.rpmBars.forEach((b, i) => b.classList.toggle('on', i < lit));
    }
    const shift = h.rpm > 11300 && !h.auto;
    if (this.hudCache.shift !== shift) {
      this.hudCache.shift = shift;
      $('hud-rpm').classList.toggle('shift', shift);
    }
    this._set('hud-mode', h.mode);
    this._set('hud-lap', h.lapLabel);
    this._set('hud-time', h.lapTime);
    this._set('hud-best', h.best);
    this._set('hud-last', h.last);
    const split = h.split || '';
    this._set('hud-split', split);
    const sEl = $('hud-split');
    if (this.hudCache.splitCls !== h.splitCls) {
      this.hudCache.splitCls = h.splitCls;
      sEl.className = h.splitCls || '';
    }
    if (this.hudCache.splitVis !== !!split) {
      this.hudCache.splitVis = !!split;
      $('hud-split-row').style.visibility = split ? 'visible' : 'hidden';
    }
    this._set('hud-cam', h.camLabel);
    const showTimer = h.showTimer !== false;
    if (this.hudCache.showTimer !== showTimer) {
      this.hudCache.showTimer = showTimer;
      for (const id of ['hud-lap', 'hud-time']) $(id).style.display = showTimer ? '' : 'none';
      document.querySelector('.hud-rows').style.display = showTimer ? '' : 'none';
    }
    // air time
    const air = $('hud-air');
    const showAir = h.airTime > 0.45 && !h.crashed;
    if (showAir) this._set('hud-air', `AIR ${h.airTime.toFixed(1)}s`);
    if (this.hudCache.air !== showAir) {
      this.hudCache.air = showAir;
      air.classList.toggle('on', showAir);
    }
    // crash
    const cb = $('crash-box');
    if (this.hudCache.crashed !== h.crashed) {
      this.hudCache.crashed = h.crashed;
      cb.classList.toggle('hidden', !h.crashed);
    }
    if (h.crashed) {
      this._set('crash-reason', h.crashReason);
      this._set('crash-hint', h.crashHint);
    }
    // fps
    const showFps = !!this.settings.graphics.showFps;
    if (showFps) this._set('fps', h.fpsText);
    if (this.hudCache.showFps !== showFps) {
      this.hudCache.showFps = showFps;
      $('fps').style.display = showFps ? 'block' : 'none';
    }
    // whip / air physics debug overlay (F3)
    const showDbg = !!this.settings.graphics.physicsDebug && !!h.whipDebug;
    if (showDbg) this._set('whip-debug', h.whipDebug);
    if (this.hudCache.showDbg !== showDbg) {
      this.hudCache.showDbg = showDbg;
      $('whip-debug').style.display = showDbg ? 'block' : 'none';
    }
    const showMap = !!this.settings.graphics.minimap;
    if (this.hudCache.showMap !== showMap) {
      this.hudCache.showMap = showMap;
      $('minimap').style.display = showMap ? 'block' : 'none';
    }
  }

  // ---------------------------------------------------------------------------------
  // Minimap
  buildMinimap(track) {
    const cv = $('minimap');
    const W = cv.width, H = cv.height;
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const ctx = off.getContext('2d');
    const b = track.bounds;
    const pad = 16;
    const sc = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxZ - b.minZ));
    const ox = W / 2 - ((b.minX + b.maxX) / 2) * sc, oz = H / 2 - ((b.minZ + b.maxZ) / 2) * sc;
    this.mm = { off, sc, ox, oz, W, H, track };
    ctx.fillStyle = 'rgba(10,10,12,0.55)';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineJoin = 'round';
    const path = () => {
      ctx.beginPath();
      for (let i = 0; i < track.n; i += 8) {
        const x = track.x[i] * sc + ox, y = track.z[i] * sc + oz;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 7;
    path();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(230,230,230,0.9)';
    ctx.lineWidth = 3.2;
    path();
    ctx.stroke();
    // features
    ctx.strokeStyle = '#f26a10';
    ctx.lineWidth = 3.2;
    for (const f of track.features) {
      ctx.beginPath();
      for (let s = f.s0; s <= f.s1; s += 2) {
        const i = track.idx(s);
        const x = track.x[i] * sc + ox, y = track.z[i] * sc + oz;
        if (s === f.s0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // finish line
    const fi = track.idx(track.finishS);
    ctx.fillStyle = '#fff';
    ctx.fillRect(track.x[fi] * sc + ox - 4, track.z[fi] * sc + oz - 4, 8, 8);
    ctx.fillStyle = '#111';
    ctx.fillRect(track.x[fi] * sc + ox - 4, track.z[fi] * sc + oz - 4, 4, 4);
    ctx.fillRect(track.x[fi] * sc + ox, track.z[fi] * sc + oz, 4, 4);
  }

  drawMinimap(x, z, heading, nextCp) {
    if (!this.mm || !this.settings.graphics.minimap) return;
    const cv = $('minimap');
    const ctx = cv.getContext('2d');
    const m = this.mm;
    ctx.clearRect(0, 0, m.W, m.H);
    ctx.drawImage(m.off, 0, 0);
    if (nextCp) {
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(nextCp.x * m.sc + m.ox, nextCp.z * m.sc + m.oz, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    const px = clamp(x * m.sc + m.ox, 6, m.W - 6), py = clamp(z * m.sc + m.oz, 6, m.H - 6);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-heading);
    ctx.fillStyle = '#f26a10';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 8);
    ctx.lineTo(5.5, -5);
    ctx.lineTo(0, -2);
    ctx.lineTo(-5.5, -5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** Track preview with the centerline, features and start/finish. */
export function drawTrackPreview(cv, track) {
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const isSand = track.def.surface === 'sand';
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, isSand ? '#3d3426' : '#1d2a18');
  g.addColorStop(1, isSand ? '#2a241b' : '#141c11');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const b = track.bounds;
  const pad = 18;
  const sc = Math.min((W - pad * 2) / (b.maxX - b.minX), (H - pad * 2) / (b.maxZ - b.minZ));
  const ox = W / 2 - ((b.minX + b.maxX) / 2) * sc, oz = H / 2 - ((b.minZ + b.maxZ) / 2) * sc;
  const path = () => {
    ctx.beginPath();
    for (let i = 0; i < track.n; i += 6) {
      const x = track.x[i] * sc + ox, y = track.z[i] * sc + oz;
      if (!i) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  ctx.lineJoin = 'round';
  ctx.strokeStyle = isSand ? '#c9b48a' : '#7a5838';
  ctx.lineWidth = Math.max(4, track.def.halfWidth * 2 * sc);
  path();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  path();
  ctx.stroke();
  ctx.strokeStyle = '#f26a10';
  ctx.lineWidth = Math.max(4, track.def.halfWidth * 2 * sc);
  for (const f of track.features) {
    ctx.beginPath();
    for (let s = f.s0; s <= f.s1; s += 2) {
      const i = track.idx(s);
      const x = track.x[i] * sc + ox, y = track.z[i] * sc + oz;
      if (s === f.s0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const fi = track.idx(track.finishS);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(track.x[fi] * sc + ox, track.z[fi] * sc + oz, 4, 0, Math.PI * 2);
  ctx.fill();
}

void formatDelta;
