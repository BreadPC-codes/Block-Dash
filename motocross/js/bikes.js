/* =====================================================================
   ROOST MX - motorcycle definitions.

   All four bikes share the chassis geometry (MX bikes are nearly the same
   size) but differ in mass, engine (torque curve, rev range, inertia,
   engine braking), gearbox and suspension. Gear ratios are given as the
   road speed (km/h) at the rev limiter in each gear with the stock
   rear sprocket; the overall ratio is derived from that.
   ===================================================================== */
(function (root) {
  'use strict';
  const MX = root.MX;

  // Shared chassis geometry, bike frame: +Z forward, +Y up, +X left,
  // origin between the footpegs at peg height. Metres.
  MX.CHASSIS = {
    rake: 27 * Math.PI / 180,          // steering axis angle from vertical
    steerHead: [0, 0.60, 0.49],        // centre of the steering head (y, z used)
    forkOffset: 0.022,                 // triple clamp offset
    forkLenExt: 0.80,                  // steering head centre -> axle, fully extended
    swingPivot: [0, 0.12, -0.10],
    swingLen: 0.585,
    rearExtAngle: 0.43,                // swingarm angle below horizontal at full extension (rad)
    wheelRadiusF: 0.350,
    wheelRadiusR: 0.345,
    tireWidthF: 0.085,
    tireWidthR: 0.115,
    pegs: [0.175, 0.0, 0.0],
    bars: [0.40, 0.68, 0.43],          // grip end (x = half width)
    seatTop: [0, 0.50, -0.12],
    riderMass: 75,
  };

  const kmh = (v) => v / 3.6;

  MX.BIKES = [
    {
      id: 'rx125', name: 'RX 125', cls: '125cc 2-Stroke', stroke: 2, cc: 125,
      desc: 'Featherweight and frantic. Tiny bottom end, a screaming top end: keep it in the powerband, fan the clutch and carry corner speed.',
      colors: { plastics: '#1d6cff', frame: '#2a2d33' },
      mass: 89,                         // kg, wet
      cogY: 0.13, cogZ: 0.07,           // bike-only centre of mass (local)
      inertia: { pitch: 26, yaw: 22, roll: 6.2 },  // bike-only, about its own CoG
      wheelInertiaF: 0.55, wheelInertiaR: 0.78,
      engine: {
        idle: 1900, limit: 12900, peakPowerRpm: 11500, inertia: 0.0036,
        torque: [[0, 3], [1500, 5], [3500, 7.2], [6000, 9.8], [8000, 13], [9000, 16.6], [10000, 20.6],
                 [10800, 22.6], [11500, 22.1], [12200, 19.6], [12900, 15]],
        friction: [0.9, 0.00028],       // engine braking Nm = a + b*rpm
        response: 26,                    // throttle response 1/s
        clutchMax: 70,                   // Nm at the crank
        flywheel: 'light',
      },
      gears: [50, 63, 76, 89, 101, 113], // km/h at the limiter
      sprocket: 50,
      susp: {
        travelF: 0.300, travelR: 0.310,
        kF: 8800, kR: 5300,              // wheel rates N/m
        progF: 6.5e4, progR: 5.5e4,     // cubic progression N/m^3
        preloadF: 40, preloadR: 120,    // N at full extension
        compF: 560, compR: 650,          // low speed compression N s/m (wheel rate)
        rebF: 700, rebR: 830,
        hsKnee: 0.7, hsCompFactor: 0.6, hsRebFactor: 0.75,
      },
      brakes: { front: 760, rear: 420 }, // max torque Nm
      handling: 1.15,                    // lean response factor
      aero: 0.52,                        // CdA m^2 (with rider)
    },
    {
      id: 'rx250', name: 'RX 250', cls: '250cc 2-Stroke', stroke: 2, cc: 250,
      desc: 'The classic open-class two-stroke. Light, raw and explosive: a soft bottom, then a savage hit in the mid-range that will loop you out if you are lazy.',
      colors: { plastics: '#e5262b', frame: '#1f2125' },
      mass: 98,
      cogY: 0.13, cogZ: 0.075,
      inertia: { pitch: 28, yaw: 24, roll: 6.6 },
      wheelInertiaF: 0.58, wheelInertiaR: 0.84,
      engine: {
        idle: 1700, limit: 10600, peakPowerRpm: 8400, inertia: 0.0068,
        torque: [[0, 6], [1500, 10], [3000, 15], [4500, 20], [5500, 26.5], [6500, 35.5], [7300, 41.2],
                 [8000, 41.6], [8800, 38], [9600, 32.5], [10600, 23]],
        friction: [1.1, 0.00035],
        response: 24,
        clutchMax: 110,
        flywheel: 'light',
      },
      gears: [55, 71, 87, 104, 122],
      sprocket: 50,
      susp: {
        travelF: 0.300, travelR: 0.310,
        kF: 9600, kR: 5900,
        progF: 7.0e4, progR: 6.0e4,
        preloadF: 50, preloadR: 140,
        compF: 610, compR: 710,
        rebF: 760, rebR: 900,
        hsKnee: 0.7, hsCompFactor: 0.6, hsRebFactor: 0.75,
      },
      brakes: { front: 840, rear: 470 },
      handling: 1.05,
      aero: 0.55,
    },
    {
      id: 'rf250', name: 'RF 250', cls: '250cc 4-Stroke', stroke: 4, cc: 250,
      desc: 'Revs to the moon and loves to be ridden hard. Smooth, predictable power with real engine braking; short-shift it and it bogs, wring it out and it flies.',
      colors: { plastics: '#22b14c', frame: '#2b2e33' },
      mass: 104,
      cogY: 0.125, cogZ: 0.08,
      inertia: { pitch: 29, yaw: 25, roll: 6.9 },
      wheelInertiaF: 0.6, wheelInertiaR: 0.88,
      engine: {
        idle: 2000, limit: 14100, peakPowerRpm: 12800, inertia: 0.0046,
        torque: [[0, 8], [2000, 12], [4000, 17], [6000, 21], [7500, 23.5], [9000, 25.5], [10000, 26.5],
                 [11000, 27], [12000, 26.6], [13000, 25.1], [14100, 21.5]],
        friction: [2.0, 0.0008],
        response: 18,
        clutchMax: 90,
        flywheel: 'medium',
      },
      gears: [52, 67, 83, 99, 116],
      sprocket: 50,
      susp: {
        travelF: 0.300, travelR: 0.310,
        kF: 9900, kR: 6100,
        progF: 7.2e4, progR: 6.2e4,
        preloadF: 55, preloadR: 150,
        compF: 625, compR: 730,
        rebF: 780, rebR: 930,
        hsKnee: 0.7, hsCompFactor: 0.6, hsRebFactor: 0.75,
      },
      brakes: { front: 860, rear: 480 },
      handling: 1.0,
      aero: 0.56,
    },
    {
      id: 'rf450', name: 'RF 450', cls: '450cc 4-Stroke', stroke: 4, cc: 450,
      desc: 'Brutal torque everywhere. It pulls third gear out of a rut and wheelies in fourth. Heavier to throw around, and it punishes a heavy right hand.',
      colors: { plastics: '#ff7a00', frame: '#33363c' },
      mass: 110,
      cogY: 0.12, cogZ: 0.08,
      inertia: { pitch: 31, yaw: 27, roll: 7.4 },
      wheelInertiaF: 0.62, wheelInertiaR: 0.92,
      engine: {
        idle: 1700, limit: 11600, peakPowerRpm: 9500, inertia: 0.0092,
        torque: [[0, 22], [1500, 30], [2500, 38], [3500, 43], [4500, 46], [5500, 48], [6500, 50],
                 [7500, 50.5], [8500, 49], [9500, 46], [10500, 41], [11600, 34]],
        friction: [3.0, 0.0012],
        response: 15,
        clutchMax: 150,
        flywheel: 'heavy',
      },
      gears: [58, 75, 93, 111, 130],
      sprocket: 50,
      susp: {
        travelF: 0.300, travelR: 0.310,
        kF: 10600, kR: 6500,
        progF: 7.6e4, progR: 6.6e4,
        preloadF: 60, preloadR: 165,
        compF: 660, compR: 780,
        rebF: 830, rebR: 990,
        hsKnee: 0.7, hsCompFactor: 0.6, hsRebFactor: 0.75,
      },
      brakes: { front: 920, rear: 510 },
      handling: 0.92,
      aero: 0.58,
    },
  ];

  MX.bikeById = function (id) { return MX.BIKES.find((b) => b.id === id) || MX.BIKES[3]; };

  // Default per-bike setup (garage). Multipliers around 1.0.
  MX.defaultSetup = function () {
    return { forkSpring: 1.0, shockSpring: 1.0, compression: 1.0, rebound: 1.0, sprocket: 50, steering: 1.0 };
  };

  // Overall gear ratios (crank rpm per wheel rpm) for a spec + setup.
  MX.gearRatios = function (spec, setup) {
    const sprocketFactor = (setup && setup.sprocket ? setup.sprocket : spec.sprocket) / spec.sprocket;
    const r = MX.CHASSIS.wheelRadiusR;
    const wLimit = spec.engine.limit * Math.PI / 30;  // rad/s at the limiter
    return spec.gears.map((v) => (wLimit / (kmh(v) / r)) * sprocketFactor);
  };

  // Rough stats for the UI bars (0..1), computed from the real data.
  MX.bikeStats = function (spec) {
    let peakP = 0, peakT = 0;
    for (let rpm = 1000; rpm <= spec.engine.limit; rpm += 100) {
      const t = MX.curveSmooth(spec.engine.torque, rpm);
      peakT = Math.max(peakT, t);
      peakP = Math.max(peakP, t * rpm * Math.PI / 30);
    }
    const ratios = MX.gearRatios(spec);
    const wheelForce1 = peakT * ratios[0] / MX.CHASSIS.wheelRadiusR;
    const accel = wheelForce1 / (spec.mass + MX.CHASSIS.riderMass);
    return {
      powerKw: peakP / 1000,
      powerHp: peakP / 745.7,
      torqueNm: peakT,
      topKmh: spec.gears[spec.gears.length - 1],
      mass: spec.mass,
      power: MX.clamp((peakP / 1000 - 20) / 30, 0.05, 1),
      torque: MX.clamp((peakT - 15) / 40, 0.05, 1),
      accel: MX.clamp((accel - 10) / 14, 0.05, 1),
      speed: MX.clamp((spec.gears[spec.gears.length - 1] - 95) / 40, 0.05, 1),
      weight: MX.clamp((spec.mass - 80) / 35, 0.05, 1),
      handling: MX.clamp((spec.handling - 0.8) / 0.4, 0.05, 1),
      suspension: MX.clamp((spec.susp.kR - 4800) / 2000, 0.05, 1),
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
