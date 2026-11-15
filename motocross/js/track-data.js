/* =====================================================================
   ROOST MX - track layouts.

   A layout is a closed loop of straights ['S', length] and arcs
   ['T', radius, degrees, opts] (positive degrees turn left as the rider
   sees it). Two straights named in `close` are stretched by the builder
   so the loop closes exactly. Features sit on a segment: { seg, at }
   with `at` in metres from the start of that segment.

   Jump kinds: table, double, stepup, stepdown, kicker, rhythm (a row of
   mounds you can single, double or triple), rollers, whoops.
   Turn options: berm (m), ruts (depth m), chop (braking bumps, m).
   ===================================================================== */
(function (root) {
  'use strict';
  const MX = root.MX;

  MX.TRACKS = [
    // ------------------------------------------------------------------ 1
    {
      id: 'practice',
      name: 'Willow Creek Practice',
      short: 'PRACTICE',
      kind: 'Practice track',
      desc: 'A wide, forgiving loop of loamy dirt in an open valley: flat corners and berms, rollers, a couple of small doubles and friendly tabletops. Leave the track and the whole valley is yours to rip around.',
      seed: 1337,
      size: 400,
      halfWidth: 5.0, blend: 4.5, margin: 3.0,
      lip: 26,
      start: { x: 40, z: -110, heading: -90 },
      close: [0, 16],
      elevSmooth: 34, crossSlope: 0.5,
      terrain: { kind: 'valley', amp: 3.5, scale: 170, detailAmp: 1.1, detailScale: 42, rim: 30 },
      surface: { trackMu: 0.92, offMu: 0.68, chop: 0.035, rough: 0.014 },
      layout: [
        ['S', 80],                                 // 0 start straight
        ['T', 18, -90, { berm: 1.0, ruts: 0.10 }],  // 1
        ['S', 55],                                 // 2 rollers
        ['T', 15, -90, { berm: 1.1 }],             // 3
        ['S', 30],                                 // 4
        ['T', 14, 180, { berm: 1.5, ruts: 0.16 }], // 5 hairpin
        ['S', 45],                                 // 6 small double
        ['T', 16, -90, { berm: 1.0, ruts: 0.10 }], // 7
        ['S', 60],                                 // 8 tabletop
        ['T', 22, -90, { berm: 0.7 }],             // 9
        ['S', 70],                                 // 10 double + rollers
        ['T', 18, -60, { berm: 0.5 }],             // 11
        ['S', 40],                                 // 12 rollers
        ['T', 20, 60, { berm: 0.4 }],              // 13 S-bend
        ['S', 30],                                 // 14
        ['T', 16, -90, { berm: 1.2, ruts: 0.14 }], // 15
        ['S', 80],                                 // 16 step-up + big table
        ['T', 17, -90, { berm: 1.2, ruts: 0.12 }], // 17
      ],
      features: [
        { type: 'finish', seg: 0, at: 22 },
        { type: 'table', seg: 0, at: 92, h: 1.2, top: 7, landAngle: 22 },
        { type: 'rollers', seg: 2, at: 9, n: 4, h: 0.7, spacing: 9 },
        { type: 'double', seg: 6, at: 10, h: 1.35, gap: 8.5, landH: 1.45, landAngle: 24 },
        { type: 'table', seg: 8, at: 14, h: 1.8, top: 10, landAngle: 24 },
        { type: 'double', seg: 10, at: 10, h: 1.7, gap: 13, landH: 1.8, landAngle: 25 },
        { type: 'rollers', seg: 10, at: 48, n: 2, h: 0.8, spacing: 10 },
        { type: 'rollers', seg: 12, at: 6, n: 3, h: 0.6, spacing: 9 },
        { type: 'stepup', seg: 16, at: 18, h: 1.3, gap: 6.5, landH: 2.4, plateau: 9, down: 9 },
        { type: 'table', seg: 16, at: 78, h: 2.1, top: 15, landAngle: 25 },
      ],
      env: {
        sky: 'day', sunElev: 48, sunAzim: 135, fog: [180, 520], fogColor: '#c5d6e6',
        trees: 520, rocks: 90, bushes: 260, stakes: true, hay: true, banners: true,
        grass: '#5d8a3a', grass2: '#7aa04a', dirt: '#8a5d3b', dirt2: '#a5734a',
      },
    },

    // ------------------------------------------------------------------ 2
    {
      id: 'supercross',
      name: 'Steel City Supercross',
      short: 'SUPERCROSS',
      kind: 'Stadium supercross',
      desc: 'Night racing on a tight stadium floor. Rhythm lanes you can double or triple, a long whoop section, a big triple, on-offs, and steep, rutted 180s. Precision beats bravery here.',
      seed: 4242,
      size: 220,
      halfWidth: 3.7, blend: 1.0, margin: 2.0,
      lip: 34,
      start: { x: -60, z: -45, heading: 90 },
      close: [0, 14],
      elevSmooth: 0, crossSlope: 0,
      terrain: { kind: 'flat' },
      stadium: { margin: 12 },
      surface: { trackMu: 0.95, offMu: 0.9, chop: 0.0, rough: 0.008, allDirt: true },
      layout: [
        ['S', 120],                                   // 0 start straight, finish table
        ['T', 7.5, -180, { berm: 1.3, ruts: 0.14 }],  // 1
        ['S', 105],                                   // 2 rhythm lane
        ['T', 7.5, 180, { berm: 1.3, ruts: 0.14 }],   // 3
        ['S', 105],                                   // 4 whoops
        ['T', 7.5, -180, { berm: 1.3, ruts: 0.16 }],  // 5
        ['S', 105],                                   // 6 big triple + on-off
        ['T', 7.5, 180, { berm: 1.3, ruts: 0.14 }],   // 7
        ['S', 105],                                   // 8 step-up rhythm
        ['T', 7.5, -90, { berm: 1.1 }],               // 9
        ['S', 10],                                    // 10
        ['T', 7.5, -90, { berm: 1.1, ruts: 0.1 }],    // 11
        ['S', 120],                                   // 12 big table + dragon's back
        ['T', 7.5, -90, { berm: 1.1 }],               // 13
        ['S', 60],                                    // 14 double
        ['T', 7.5, -90, { berm: 1.1, ruts: 0.1 }],    // 15
      ],
      features: [
        { type: 'gate', seg: 0, at: 4 },
        { type: 'finish', seg: 0, at: 44 },
        { type: 'table', seg: 0, at: 64, h: 1.6, top: 8, landAngle: 28 },
        { type: 'rhythm', seg: 2, at: 12, n: 8, h: 1.35, spacing: 9.5, up: 2.6, down: 3.2 },
        { type: 'whoops', seg: 4, at: 14, n: 15, h: 0.72, spacing: 3.7 },
        { type: 'double', seg: 4, at: 82, h: 1.4, gap: 7, landH: 1.5, landAngle: 28 },
        { type: 'double', seg: 6, at: 14, h: 2.0, gap: 20, landH: 2.2, landAngle: 30 },
        { type: 'table', seg: 6, at: 68, h: 1.6, top: 6, landAngle: 32 },
        { type: 'stepup', seg: 8, at: 12, h: 1.4, gap: 6, landH: 2.3, plateau: 5, down: 6 },
        { type: 'rhythm', seg: 8, at: 52, n: 4, h: 1.3, spacing: 9, up: 2.5, down: 3.0 },
        { type: 'table', seg: 12, at: 16, h: 2.0, top: 14, landAngle: 28 },
        { type: 'rollers', seg: 12, at: 72, n: 5, h: 1.2, spacing: 6.2 },
        { type: 'double', seg: 14, at: 18, h: 1.6, gap: 10, landH: 1.7, landAngle: 30 },
      ],
      env: {
        sky: 'night', sunElev: 70, sunAzim: 200, fog: [140, 420], fogColor: '#0b0e18',
        trees: 0, rocks: 0, bushes: 0, stakes: false, hay: false, banners: true, tuffBlocks: true,
        grass: '#6b4a2e', grass2: '#7a5636', dirt: '#6e4a2f', dirt2: '#87593a',
      },
    },

    // ------------------------------------------------------------------ 3
    {
      id: 'outdoor',
      name: 'Red Ridge National',
      short: 'OUTDOOR MX',
      kind: 'Outdoor motocross',
      desc: 'A big, fast natural-terrain circuit carved into the hills. Long uphills and drops, off-camber sweepers, deep ruts, braking bumps and huge tabletops and step-ups. Rough, physical and long.',
      seed: 9001,
      size: 680,
      halfWidth: 5.2, blend: 5.0, margin: 3.0,
      lip: 28,
      start: { x: 0, z: 0, heading: 90 },
      close: [0, 18],
      elevSmooth: 30, crossSlope: 0.6,
      terrain: { kind: 'hills', amp: 21, scale: 300, detailAmp: 4.0, detailScale: 70, bumpAmp: 0.35, rim: 60 },
      surface: { trackMu: 0.9, offMu: 0.66, chop: 0.05, rough: 0.018, uneven: 0.06 },
      layout: [
        ['S', 150],                                   // 0 start straight
        ['T', 26, 60, { berm: 0.9, ruts: 0.15 }],     // 1
        ['S', 60],                                    // 2 step-up
        ['T', 18, -60, { berm: 1.0, ruts: 0.18 }],    // 3
        ['S', 50],                                    // 4 rollers
        ['T', 20, 90, { berm: 1.2, ruts: 0.2 }],      // 5
        ['S', 115],                                   // 6 the big double
        ['T', 16, 160, { berm: 1.6, ruts: 0.24 }],    // 7 hairpin
        ['S', 90],                                    // 8 step-down
        ['T', 30, -160, { berm: 1.0, ruts: 0.2 }],    // 9 big sweeping 180
        ['S', 95],                                    // 10 table + rollers
        ['T', 22, 90, { berm: 0.8, ruts: 0.15 }],     // 11
        ['S', 40],                                    // 12 whoops
        ['T', 18, 40, {}],                            // 13 off-camber kink
        ['S', 40],                                    // 14 kicker
        ['T', 30, -40, {}],                           // 15 off-camber
        ['S', 50],                                    // 16 double
        ['T', 35, 90, { berm: 0.9, ruts: 0.15 }],     // 17
        ['S', 140],                                   // 18 long uphill: big table + rollers
        ['T', 20, 90, { berm: 1.3, ruts: 0.2 }],      // 19
      ],
      features: [
        { type: 'finish', seg: 0, at: 40 },
        { type: 'table', seg: 0, at: 100, h: 2.2, top: 14, landAngle: 26 },
        { type: 'stepup', seg: 2, at: 12, h: 1.8, gap: 8, landH: 3.0, plateau: 9, down: 10 },
        { type: 'rollers', seg: 4, at: 8, n: 3, h: 0.9, spacing: 11 },
        { type: 'double', seg: 6, at: 28, h: 2.4, gap: 23, landH: 2.6, landAngle: 26 },
        { type: 'stepdown', seg: 8, at: 14, h: 2.4, rise: 18, gap: 14, landH: 1.0, landAngle: 22 },
        { type: 'table', seg: 10, at: 12, h: 2.0, top: 12, landAngle: 25 },
        { type: 'rollers', seg: 10, at: 55, n: 2, h: 0.9, spacing: 10 },
        { type: 'whoops', seg: 12, at: 4, n: 6, h: 0.8, spacing: 5.5 },
        { type: 'kicker', seg: 14, at: 16, h: 0.9 },
        { type: 'double', seg: 16, at: 10, h: 1.6, gap: 12, landH: 1.4, landAngle: 22 },
        { type: 'table', seg: 18, at: 25, h: 2.6, top: 18, landAngle: 27 },
        { type: 'rollers', seg: 18, at: 88, n: 4, h: 1.0, spacing: 12 },
      ],
      env: {
        sky: 'evening', sunElev: 22, sunAzim: 250, fog: [260, 900], fogColor: '#e2c6a2',
        trees: 1400, rocks: 260, bushes: 500, stakes: true, hay: true, banners: true,
        grass: '#6f8a3c', grass2: '#94a04f', dirt: '#9a5a33', dirt2: '#b5703f',
      },
    },
  ];

  MX.trackById = function (id) { return MX.TRACKS.find((t) => t.id === id) || MX.TRACKS[0]; };
})(typeof window !== 'undefined' ? window : globalThis);
