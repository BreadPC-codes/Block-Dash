# Block Dash

A single-player 3D obstacle survival game in one file: `index.html` (HTML, CSS and JavaScript, with [Three.js](https://threejs.org/) r170 loaded from a CDN).

Blocks sweep across a floating 8-lane arena in waves. Steer through the gaps, jump the low barriers and time the crushers. Every wave you fully survive adds one to the **WAVE SURVIVED** counter.

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
| Pause | `Esc` or `P`, or the ❚❚ button | ❚❚ button |
| Look around | Drag with the mouse (springs back) | n/a |
| Restart / menu | `R` / `Enter` / `Esc` on the pause and game-over screens | Buttons |

Touch controls appear automatically on touch devices. You can steer and jump at the same time with two thumbs.

## How the waves work

Each wave is an 8×8 ASCII grid. Columns `A`–`H` are the lanes. Rows arrive in order **8 → 1**: row 8 reaches you first and row 1 last.

| Symbol | Meaning |
|---|---|
| `#` | Solid block, too tall to jump |
| `.` | Gap |
| `J` | Low barrier: jump it or go around |
| `M` | Moving crusher: rises and slams down; pass under only while it is raised |

The six patterns from the brief (Basic Corridor, Alternating Gaps, Double Corridors, Jump Challenge, Narrow Zigzag, Moving Obstacles) are included verbatim. Six more unlock as the wave count grows: Hurdle Run, Staircase, Hop Scotch, Split Decision, Crusher Alley and The Gauntlet.

The pattern engine parses each grid and rejects malformed or impossible patterns when the page loads. It then lays out every wave with a survivability solver:

- The arena width is sampled every 0.1 units, and each row is classified as free, needs a jump, or blocked for the player's hitbox. Crushers count as blocked, so a wave never depends on crusher timing.
- For each pair of consecutive rows, the solver works out how long the player needs to get from any position they could be in to the nearest safe spot in the next row. This accounts for acceleration, landing after a jump and setting up the next jump. Rows are then spaced so that much time always exists at the current speed, plus a reaction margin.
- Waves are spaced the same way, so the first row of the next wave is always reachable from wherever the last one could leave you.

Speed rises after every cleared wave, the reaction margin shrinks, harder patterns become more likely, and from wave 6 a pattern may arrive mirrored.

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
