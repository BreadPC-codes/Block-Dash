# Block Dash

A single-player 3D obstacle survival game in one file: `index.html` (HTML, CSS and JavaScript, with [Three.js](https://threejs.org/) r170 loaded from a CDN).

Walls of cube blocks sweep across a small floating 10-lane arena with a checkered floor, one wave at a time. Slip through the holes, jump or dive over single cubes, or climb on top and ride. A wall that catches you pushes you toward the edge, so slide into a hole before you run out of floor. Laser fences along both edges are always on; the only way around the walls over the edge is a jump from the top of a block. Every wave you fully survive adds one to the **WAVE SURVIVED** counter.

You play as a chunky little party-game runner (an original character) who runs, jumps, flails and tumbles.

## Running it

Open `index.html` in a modern browser (Chrome, Edge, Firefox or Safari, desktop or mobile). There is no build step and nothing to install.

The page needs an internet connection to fetch Three.js (from jsDelivr, with unpkg as a fallback) and its web fonts. You can also serve the folder locally:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Controls

| | Desktop | Touch (phones and tablets) |
|---|---|---|
| Move | `W A S D` or arrow keys | Virtual joystick, bottom-left |
| Jump | `Space` | **JUMP** button, bottom-right |
| Dive | `Space` again while in the air | Tap **JUMP** again while in the air |
| Pause | `Esc` or `P`, or the ❚❚ button | ❚❚ button |
| Look around | Drag with the mouse (springs back) | n/a |
| Restart / menu | `R` / `Enter` / `Esc` on the pause and game-over screens | Buttons |

Touch controls appear automatically on touch devices. You can steer and jump at the same time with two thumbs.

## How the waves work

Each wave is an 8×8 ASCII grid. Every wave has its own block colour, different from the wave before it. Most waves are wall waves in the style of sweeping block-wall party games: one full-width wall per row, with holes and low parts, and gaps between walls. The layouts are original. Columns `A`–`H` are the lanes. Rows arrive in order **8 → 1**: row 8 reaches you first and row 1 last.

| Symbol | Meaning |
|---|---|
| `#` | Stack of 2–3 cubes: too tall to jump |
| `.` | Hole |
| `J` | Single cube: a jump gets you on top, and a running jump or a dive clears it |
| `M` | Moving crusher: rises and slams down; if it lands on you, you're bonked forward and dazed for a moment |

How contact works:

- **Front of an incoming wall:** it pushes you along with it. You can slide sideways along it freely into a hole, or run away from it.
- **Side of a block:** solid. You stop against it.
- **Top of a block:** safe to stand on. A ridden block carries you toward the near edge, and you keep that momentum when you jump off. Every block is the same cube, and taller obstacles are whole cubes stacked on top of each other. Stacks can't be reached from the floor; climb onto them from a single block.
- **Dive:** press jump again in the air. You lunge forward in your steering direction (or the way you face) with a small hop and a low profile, covering about 6.4 units from the top of a jump, then do a short belly slide.

The run only ends if you **fall off the arena** (pushed off, ridden off or walked off) or **touch a laser fence**. The far end is a solid gate, so you can't hide behind the spawn line.

The six patterns from the brief (Basic Corridor, Alternating Gaps, Double Corridors, Jump Challenge, Narrow Zigzag, Moving Obstacles) are included verbatim. Six wall waves (Wall Rush, Hop or Hole, Slider, Twin Walls, Crusher Wall, Last Gap) are picked more often than the rest. Six more grid patterns also unlock as the wave count grows: Hurdle Run, Staircase, Hop Scotch, Split Decision, Crusher Alley and The Gauntlet.

The pattern engine parses each grid and rejects malformed or impossible patterns when the page loads. It then lays out every wave with a survivability solver:

- The arena width is sampled every 0.1 units, and each row is classified as free, needs a jump, or blocked for the player's hitbox. Wall sections and crushers count as blocked, so a wave never depends on climbing, riding, diving or crusher timing.
- For each pair of consecutive rows, the solver works out how long the player needs to get from any position they could be in to the nearest safe spot in the next row. This accounts for acceleration, landing after a jump and setting up the next jump. Rows are then spaced so that much time always exists at the current speed, plus a reaction margin.
- Waves are spaced the same way, so the first row of the next wave is always reachable from wherever the last one could leave you.

The blocks start slow (7 units/s) and get 5% faster every 20 waves. Only one wave is on the map at a time: the next one starts at the gate once every row of the previous wave has left over the near edge. Meanwhile the reaction margin shrinks, harder patterns become more likely, and from wave 6 a pattern may arrive mirrored. The arena is 10 lanes wide; the 8-column patterns are centred on it and their outer columns extend to the edges. The patterns are authored with the chessboard-style `A`–`H` / `8`–`1` grid below, but no lane letters or row numbers are drawn in the game.

### Adding a pattern

Append an entry to `PATTERN_DEFS` in `index.html`:

```js
{ id: 'my-pattern', name: 'My Pattern', minWave: 5, rating: 3, ascii: `
      A B C D E F G H
  8 | # # . . # # # # |
  ...
  1 | # # # . . # # # |` },
```

`minWave` is the earliest wave index (0-based) it can appear at. `rating` (1–5) steers how often it is picked at a given difficulty. Invalid patterns are logged to the console and skipped.

## Settings and saved data

The Settings screen covers graphics quality (Low, Medium, High), mouse and camera sensitivity, joystick sensitivity and size, volume, sound effects, music and vibration. Settings and the personal best are stored in `localStorage` under `blockdash.settings.v1` and `blockdash.bestWave`.

## Debugging

Add `?debug=1` to the URL to expose `window.BlockDash` (game state, world, player and the pattern solver) in the browser console.
