// Track definitions. Layout commands:
//   ['S', length, { features, w, flat, gate, finish }]   straight
//   ['L'|'R', angleDeg, radius, { berm, w }]             constant radius turn (rider-relative)
//   ['CLOSE', radius]                                     Dubins path back to the start
// Feature `at` values are meters from the start of their straight.

export const TRACKS = [
  {
    id: 'ridgeback',
    name: 'Ridgeback Valley',
    kind: 'Outdoor Motocross',
    description:
      'A full-size outdoor circuit carved into a grassy valley. Long start straight, rhythm lanes, a triple, whoops, a step-up and a big uphill tabletop.',
    seed: 4127,
    size: 640,
    surface: 'dirt',
    groundStyle: 'valley',
    vegetation: 'mixed',
    halfWidth: 4.6,
    undulation: 3.5,
    mountainHeight: 85,
    checkpoints: 10,
    layout: [
      ['S', 150, { w: 7.2, flat: true, gate: 20, finish: 96 }],
      ['L', 180, 15],
      ['S', 120, {
        features: [
          { type: 'double', at: 22, h1: 1.9, face: 27, gap: 15, h2: 1.9, land: 22 },
          { type: 'table', at: 74, h: 1.5, face: 26, top: 7, land: 22 },
        ],
      }],
      ['R', 180, 14],
      ['S', 110, { features: [{ type: 'rhythm', at: 16, mounds: [1.2, 1.35, 1.35, 1.4, 1.3, 1.45], spacing: 1.6 }] }],
      ['L', 180, 14],
      ['S', 124, {
        features: [
          { type: 'whoops', at: 14, n: 12, h: 0.45, spacing: 3.6 },
          { type: 'rollers', at: 72, n: 4, h: 0.65, len: 9 },
        ],
      }],
      ['R', 90, 16],
      ['S', 52, { features: [{ type: 'table', at: 16, h: 1.25, face: 25, top: 4, land: 22 }] }],
      ['R', 90, 15],
      ['S', 134, {
        features: [
          { type: 'double', at: 22, h1: 2.1, face: 26, gap: 23, h2: 2.1, land: 22, mid: { h: 1.8, w: 10 } },
          { type: 'rollers', at: 88, n: 3, h: 0.6, len: 8.5 },
        ],
      }],
      ['S', 52, {}],
      ['R', 90, 16],
      ['S', 186, {
        features: [
          { type: 'table', at: 30, h: 2.8, face: 26, top: 16, land: 20 },
          { type: 'stepup', at: 112, h1: 1.6, face: 28, gap: 7, h2: 2.9, plateau: 8, down: 13 },
        ],
      }],
      ['R', 90, 16],
      ['S', 176, {
        features: [
          { type: 'double', at: 22, h1: 2.0, face: 27, gap: 17, h2: 2.0, land: 21 },
          { type: 'whoops', at: 78, n: 8, h: 0.42, spacing: 3.5 },
          { type: 'table', at: 124, h: 1.7, face: 27, top: 9, land: 22 },
        ],
      }],
      ['CLOSE', 17],
    ],
    hills: [
      { seg: 13, t: 0.55, h: 9, r: 70, side: 40 },
      { seg: 9, t: 0.4, h: -3.5, r: 60, side: -30 },
    ],
    pits: [{ seg: 0, at: 70, side: -1, offset: 34, length: 90, depth: 30 }],
  },
  {
    id: 'pinehollow',
    name: 'Pine Hollow Practice',
    kind: 'Compact Practice Track',
    description:
      'A tight practice loop in the pines. Small tables, a mellow double, rollers and short whoops - perfect for learning throttle and jump control.',
    seed: 9001,
    size: 480,
    surface: 'dirt',
    groundStyle: 'valley',
    vegetation: 'pine',
    halfWidth: 4.3,
    undulation: 2.2,
    mountainHeight: 60,
    checkpoints: 6,
    layout: [
      ['S', 100, { w: 6, flat: true, gate: 16, finish: 62 }],
      ['L', 180, 13],
      ['S', 84, { features: [{ type: 'table', at: 18, h: 1.4, face: 25, top: 8, land: 22 }] }],
      ['R', 180, 12],
      ['S', 74, { features: [{ type: 'rollers', at: 12, n: 4, h: 0.6, len: 8.5 }] }],
      ['L', 90, 12],
      ['S', 50, { features: [{ type: 'double', at: 9, h1: 1.4, face: 25, gap: 10, h2: 1.4, land: 22 }] }],
      ['L', 90, 12],
      ['S', 104, {
        features: [
          { type: 'whoops', at: 14, n: 8, h: 0.38, spacing: 3.4 },
          { type: 'table', at: 60, h: 1.1, face: 24, top: 4, land: 22 },
        ],
      }],
      ['L', 90, 14],
      ['S', 96, { features: [{ type: 'double', at: 18, h1: 1.6, face: 26, gap: 13, h2: 1.6, land: 22 }] }],
      ['CLOSE', 13],
    ],
    hills: [{ seg: 10, t: 0.5, h: 4, r: 45, side: -25 }],
    pits: [{ seg: 0, at: 45, side: -1, offset: 26, length: 60, depth: 22 }],
  },
  {
    id: 'dunecoast',
    name: 'Dune Coast',
    kind: 'Sand Track',
    description:
      'Deep, rolling sand between the dunes by the sea. Grip is lower, rolling drag is high and the whoops are brutal - carry your momentum.',
    seed: 2718,
    size: 640,
    surface: 'sand',
    groundStyle: 'dunes',
    vegetation: 'coastal',
    seaSide: 'south',
    halfWidth: 5.0,
    undulation: 4.5,
    checkpoints: 8,
    layout: [
      ['S', 130, { w: 7.2, flat: true, gate: 18, finish: 84 }],
      ['L', 150, 18],
      ['S', 124, { features: [{ type: 'whoops', at: 20, n: 14, h: 0.5, spacing: 3.8 }] }],
      ['R', 120, 16],
      ['S', 112, { features: [{ type: 'double', at: 18, h1: 2.0, face: 27, gap: 16, h2: 2.0, land: 22 }] }],
      ['L', 165, 15],
      ['S', 196, {
        features: [
          { type: 'rollers', at: 12, n: 5, h: 0.75, len: 9.5 },
          { type: 'table', at: 72, h: 1.8, face: 26, top: 10, land: 21 },
          { type: 'whoops', at: 136, n: 10, h: 0.45, spacing: 3.7 },
        ],
      }],
      ['L', 75, 18],
      ['S', 150, { features: [{ type: 'rhythm', at: 18, mounds: [1.3, 1.5, 1.4, 1.5], spacing: 2.0 }, { type: 'table', at: 92, h: 1.6, face: 26, top: 8, land: 22 }] }],
      ['CLOSE', 16],
    ],
    hills: [{ seg: 6, t: 0.5, h: 6, r: 60, side: 40 }],
    pits: [{ seg: 0, at: 60, side: -1, offset: 34, length: 80, depth: 28 }],
  },
];

export function getTrackDef(id) {
  return TRACKS.find((t) => t.id === id) || TRACKS[0];
}
