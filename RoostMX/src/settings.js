// Persistent settings and lap records (localStorage).

// Riding actions, in the order they are listed in Settings > Controls.
// Bike and rider are controlled separately (MX Bikes style): steering leans/turns the
// bike, the rider-lean actions move the rider's body left/right and forward/back.
export const ACTIONS = [
  'throttle', 'brakeFront', 'brakeRear', 'steerLeft', 'steerRight',
  'riderLeft', 'riderRight', 'leanForward', 'leanBack',
  'shiftUp', 'shiftDown', 'reset', 'marker', 'camera', 'lookBack',
  'camLeft', 'camRight', 'camUp', 'camDown', 'pause',
];

export const DEFAULT_KEYS = {
  throttle: ['KeyW', ''],
  brakeFront: ['Space', ''],
  brakeRear: ['KeyS', ''],
  steerLeft: ['KeyA', ''],
  steerRight: ['KeyD', ''],
  riderLeft: ['ArrowLeft', ''],
  riderRight: ['ArrowRight', ''],
  leanForward: ['ArrowUp', ''],
  leanBack: ['ArrowDown', ''],
  shiftUp: ['KeyE', ''],
  shiftDown: ['KeyQ', ''],
  reset: ['KeyR', ''],
  // hold 3 s on the ground: set a track marker; tap: back to the marker (shares the key
  // with rider lean back on purpose - holding still leans, a quick tap goes back)
  marker: ['ArrowDown', ''],
  camera: ['KeyC', ''],
  lookBack: ['KeyB', ''],
  camLeft: ['', ''],
  camRight: ['', ''],
  camUp: ['', ''],
  camDown: ['', ''],
};

/**
 * Controller bindings. Codes: 'b7' = button 7, 'a0-' / 'a0+' = axis 0 pushed negative /
 * positive, 'a5t+' = trigger-style axis resting at -1 (full travel = 0..1).
 * Defaults follow the standard (Xbox) layout: left stick steers the bike (X) and moves the
 * rider forward / back (Y), right stick leans the rider left / right, triggers throttle /
 * front brake, d-pad looks around.
 */
export const DEFAULT_PAD = {
  throttle: ['b7', ''],
  brakeFront: ['b6', ''],
  brakeRear: ['b2', ''],
  steerLeft: ['a0-', ''],
  steerRight: ['a0+', ''],
  riderLeft: ['a2-', ''],
  riderRight: ['a2+', ''],
  leanForward: ['a1-', ''],
  leanBack: ['a1+', ''],
  shiftUp: ['b5', ''],
  shiftDown: ['b4', ''],
  reset: ['b0', 'b8'],
  marker: ['', ''],
  camera: ['b3', ''],
  lookBack: ['b1', ''],
  camLeft: ['b14', ''],
  camRight: ['b15', ''],
  camUp: ['b12', ''],
  camDown: ['b13', ''],
  pause: ['b9', ''],
};

export const ACTION_LABELS = {
  throttle: 'Throttle',
  brakeRear: 'Rear brake',
  brakeFront: 'Front brake',
  steerLeft: 'Steer / lean bike left',
  steerRight: 'Steer / lean bike right',
  riderLeft: 'Rider lean left',
  riderRight: 'Rider lean right',
  leanForward: 'Rider lean forward',
  leanBack: 'Rider lean back',
  shiftUp: 'Shift up',
  shiftDown: 'Shift down',
  reset: 'Reset bike',
  marker: 'Track marker (hold 3 s: set · tap: go back)',
  camera: 'Change camera',
  lookBack: 'Look back',
  camLeft: 'Camera left',
  camRight: 'Camera right',
  camUp: 'Camera up',
  camDown: 'Camera down',
  pause: 'Pause',
};

export const DEFAULT_SETTINGS = {
  version: 1,
  bike: {
    color: '#f26a10',
    number: '27',
    steerSens: 1.0,
    enginePower: 1.0,
    suspStiffness: 1.0,
    suspDamping: 1.0,
    brakeFront: 1.0,
    brakeRear: 1.0,
    grip: 1.0,
    airControl: 1.0,
    autoGearbox: true,
    assist: 2,
  },
  controls: {
    keys: JSON.parse(JSON.stringify(DEFAULT_KEYS)),
    pad: JSON.parse(JSON.stringify(DEFAULT_PAD)),
    padVersion: 3,
    padSteerSens: 1.0,
    padDeadzone: 0.12,
    invertLean: false,
    linkedBrakes: true,
  },
  camera: {
    sensitivity: 1.0,
    distance: 1.0,
    mode: 'chase',
  },
  graphics: {
    quality: 'high',
    renderScale: 1.0,
    dynamicRes: true,
    antialias: 'auto',
    fullscreen: true,
    showFps: false,
    physicsDebug: false,
    units: 'kmh',
    minimap: true,
    freeRideTimer: true,
  },
  audio: {
    master: 0.8,
    engine: 0.85,
    effects: 0.8,
  },
  game: {
    track: 'ridgeback',
    mode: 'free',
    activeBike: 'procedural',
  },
};

const KEY = 'roostmx.settings.v1';
const REC_KEY = 'roostmx.records.v1';

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over)) {
    const b = base ? base[k] : undefined;
    const o = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o)) out[k] = deepMerge(b, o);
    else if (o !== undefined && (b === undefined || typeof b === typeof o)) out[k] = o;
  }
  return out;
}

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function safeSet(key, val) {
  try {
    localStorage.setItem(key, val);
    return true;
  } catch (e) {
    return false;
  }
}

export function hasSavedSettings() {
  return !!safeGet(KEY);
}

export function loadSettings() {
  const raw = safeGet(KEY);
  let s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (raw) {
    try {
      s = deepMerge(s, JSON.parse(raw));
    } catch (e) {
      console.warn('Settings reset (corrupt data)');
    }
  }
  // make sure every action has two slots
  const fix = (table, defaults) => {
    for (const k of Object.keys(defaults)) {
      if (!Array.isArray(table[k])) table[k] = defaults[k].slice();
      while (table[k].length < 2) table[k].push('');
      table[k] = table[k].slice(0, 2).map((v) => (typeof v === 'string' ? v : ''));
    }
  };
  if (!s.controls.keys || typeof s.controls.keys !== 'object') s.controls.keys = {};
  fix(s.controls.keys, DEFAULT_KEYS);
  // older versions had a fixed controller layout: start from the new defaults
  if (!s.controls.pad || typeof s.controls.pad !== 'object' || (s.controls.padVersion || 1) < 2) {
    s.controls.pad = JSON.parse(JSON.stringify(DEFAULT_PAD));
    s.controls.padVersion = 3;
  }
  fix(s.controls.pad, DEFAULT_PAD);
  // v2 -> v3: rider forward / back moved from the right stick to the left stick (only when
  // the player still had the old defaults there)
  if ((s.controls.padVersion || 2) < 3) {
    const P = s.controls.pad;
    if (P.leanForward[0] === 'a3-' && P.leanBack[0] === 'a3+') {
      for (const a of Object.keys(P)) for (let i = 0; i < 2; i++) if (P[a][i] === 'a1-' || P[a][i] === 'a1+') P[a][i] = '';
      P.leanForward[0] = 'a1-';
      P.leanBack[0] = 'a1+';
    }
    s.controls.padVersion = 3;
  }
  return s;
}

export function saveSettings(s) {
  return safeSet(KEY, JSON.stringify(s));
}

export function loadRecords() {
  try {
    return JSON.parse(safeGet(REC_KEY) || '{}') || {};
  } catch (e) {
    return {};
  }
}

export function saveRecords(r) {
  return safeSet(REC_KEY, JSON.stringify(r));
}

export function keyLabel(code) {
  if (!code) return '—';
  const map = {
    Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

const PAD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'L-Stick', 'R-Stick', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
const STICK_DIR = { '0-': 'L-Stick ←', '0+': 'L-Stick →', '1-': 'L-Stick ↑', '1+': 'L-Stick ↓', '2-': 'R-Stick ←', '2+': 'R-Stick →', '3-': 'R-Stick ↑', '3+': 'R-Stick ↓' };

/** Human readable name of a controller binding code. */
export function padLabel(code, standard = true) {
  if (!code) return '—';
  let m = /^b(\d+)$/.exec(code);
  if (m) {
    const i = +m[1];
    return standard && PAD_BUTTONS[i] ? PAD_BUTTONS[i] : 'Button ' + i;
  }
  m = /^a(\d+)(t?)([+-])$/.exec(code);
  if (m) {
    if (m[2]) return 'Axis ' + m[1] + (m[3] === '+' ? ' ▲' : ' ▼');
    const k = m[1] + m[3];
    return standard && STICK_DIR[k] ? STICK_DIR[k] : 'Axis ' + m[1] + ' ' + m[3];
  }
  return code;
}
