/* =====================================================================
   ROOST MX - settings, garage and records (saved in localStorage).
   ===================================================================== */
MX.module('settings', function (THREE, MX) {
  'use strict';

  MX.QUALITY = {
    low:    { level: 0, pixelRatio: 0.75, shadows: false, shadowSize: 1024, trees: 0.35, particles: 400, marks: 1200, ribbonStep: 0.34, terrainCell: 3.0, antialias: false },
    medium: { level: 1, pixelRatio: 1.0, shadows: true, shadowSize: 1024, trees: 0.6, particles: 650, marks: 1800, ribbonStep: 0.27, terrainCell: 2.5, antialias: true },
    high:   { level: 2, pixelRatio: 1.5, shadows: true, shadowSize: 2048, trees: 1.0, particles: 900, marks: 2400, ribbonStep: 0.22, terrainCell: 2.0, antialias: true },
    ultra:  { level: 3, pixelRatio: 2.0, shadows: true, shadowSize: 4096, trees: 1.0, particles: 1400, marks: 3200, ribbonStep: 0.18, terrainCell: 1.5, antialias: true },
  };

  MX.defaultSettings = () => ({
    graphics: { quality: 'high', resScale: 1.0, shadows: true, fov: 70, showFps: false },
    audio: { master: 0.8, engine: 0.85, effects: 0.8, music: 0.45, gameMusic: false },
    gameplay: { autoClutch: true, autoShift: false, tractionControl: true, riderAssist: 1, units: 'kmh', showInputs: true,
      cameraDistance: 1.0, cameraHeight: 1.0, cameraSensitivity: 1.0, invertX: false, invertY: false, defaultCamera: 'chase', mouseLook: true },
    keyboard: { bindings: MX.defaultKeys() },
    controller: { deadzone: 0.12, triggerDeadzone: 0.04, steerSensitivity: 1.0, throttleSensitivity: 1.0, brakeSensitivity: 1.0,
      cameraSensitivity: 1.0, invertX: false, invertY: false, vibration: true, custom: false, bindings: MX.defaultPad() },
  });

  MX.defaultGarage = () => ({ bike: 'rf450', track: 'practice', look: MX.defaultLook(), paint: {}, setups: {} });

  // paint is per bike (factory colours by default); rider gear & number are shared
  MX.PAINT_KEYS = ['plastics', 'graphics', 'graphicsColor', 'frame', 'seat', 'rims', 'plateBg', 'plateNum'];
  MX.factoryPaint = (spec) => ({
    plastics: spec.colors.plastics, graphics: 'race', graphicsColor: spec.id === 'rx125' || spec.id === 'rf250' ? '#f2f2f2' : '#1a1a1a',
    frame: spec.id === 'rf250' ? '#1b1d22' : spec.id === 'rx125' ? '#9aa0a8' : spec.id === 'rx250' ? '#c9a03a' : '#9aa0a8',
    seat: '#1b1d22', rims: spec.id === 'rx250' ? '#c9a03a' : '#202226', plateBg: spec.id === 'rx125' ? '#1d6cff' : '#ffffff', plateNum: spec.id === 'rx125' ? '#ffffff' : '#111111',
  });
  MX.lookFor = function (garage, bikeId) {
    const spec = MX.bikeById(bikeId);
    const look = Object.assign(MX.defaultLook(), garage.look || {});
    Object.assign(look, MX.factoryPaint(spec), (garage.paint && garage.paint[bikeId]) || {});
    return look;
  };

  MX.loadSettings = function () {
    const s = MX.mergeDefaults(MX.defaultSettings(), MX.load('settings', null));
    // bindings are open maps: keep saved ones, fill missing actions with defaults
    const saved = MX.load('settings', null);
    if (saved && saved.keyboard && saved.keyboard.bindings) s.keyboard.bindings = Object.assign(MX.defaultKeys(), saved.keyboard.bindings);
    if (saved && saved.controller && saved.controller.bindings) s.controller.bindings = Object.assign(MX.defaultPad(), saved.controller.bindings);
    if (!MX.QUALITY[s.graphics.quality]) s.graphics.quality = 'high';
    return s;
  };
  MX.saveSettings = (s) => MX.save('settings', s);

  MX.loadGarage = function () {
    const saved = MX.load('garage', null);
    const g = MX.mergeDefaults(MX.defaultGarage(), saved);
    g.look = Object.assign(MX.defaultLook(), saved && saved.look ? saved.look : {});
    g.setups = (saved && saved.setups) || {};
    g.paint = (saved && saved.paint) || {};
    if (!MX.BIKES.find((b) => b.id === g.bike)) g.bike = 'rf450';
    if (!MX.TRACKS.find((t) => t.id === g.track)) g.track = 'practice';
    return g;
  };
  MX.saveGarage = (g) => MX.save('garage', g);
  MX.setupFor = (garage, bikeId) => Object.assign(MX.defaultSetup(), garage.setups[bikeId] || {});

  MX.loadRecords = () => MX.load('records', {}) || {};
  MX.saveRecords = (r) => MX.save('records', r);
});
