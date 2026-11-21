// Persistent settings and lap records (localStorage).

export const DEFAULT_KEYS = {
  throttle: ['KeyW', ''],
  brakeRear: ['KeyS', ''],
  steerLeft: ['KeyA', ''],
  steerRight: ['KeyD', ''],
  brakeFront: ['Space', ''],
  leanForward: ['ArrowUp', ''],
  leanBack: ['ArrowDown', ''],
  shiftUp: ['KeyE', ''],
  shiftDown: ['KeyQ', ''],
  reset: ['KeyR', ''],
  camera: ['KeyC', ''],
  lookBack: ['KeyB', ''],
};

export const ACTION_LABELS = {
  throttle: 'Throttle',
  brakeRear: 'Rear brake',
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  brakeFront: 'Front brake',
  leanForward: 'Lean forward',
  leanBack: 'Lean back',
  shiftUp: 'Shift up',
  shiftDown: 'Shift down',
  reset: 'Reset bike',
  camera: 'Change camera',
  lookBack: 'Look back',
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
    autoGearbox: true,
    assist: 2,
  },
  controls: {
    keys: JSON.parse(JSON.stringify(DEFAULT_KEYS)),
    padSteerSens: 1.0,
    padDeadzone: 0.12,
    invertLean: false,
  },
  camera: {
    sensitivity: 1.0,
    distance: 1.0,
    mode: 'chase',
  },
  graphics: {
    quality: 'high',
    fullscreen: true,
    showFps: false,
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
  for (const k of Object.keys(DEFAULT_KEYS)) {
    if (!Array.isArray(s.controls.keys[k])) s.controls.keys[k] = DEFAULT_KEYS[k].slice();
    while (s.controls.keys[k].length < 2) s.controls.keys[k].push('');
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
