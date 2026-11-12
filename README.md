# Block Dash

A single-player 3D obstacle survival game in one file: `index.html` (HTML, CSS and JavaScript, with [Three.js](https://threejs.org/) r170 loaded from a CDN).

Walls of cube blocks sweep across a small floating 12-lane arena with a slightly slippery checkered floor, one wave at a time and at most one new wall every 7 seconds. Slip through the holes, jump or dive over single cubes, or climb on top and ride. A wall that catches you pushes you toward the edge, so slide into a hole before you run out of floor. The always-on laser fences stand right beside the outer lanes, so there is no way around a wall at the sides: every wall reaches from fence to fence. Every wave you fully survive adds one to the **WAVE SURVIVED** counter.

Pick a **difficulty** on the main menu with the slider, from Very easy to Very hard. On Normal and harder, some walls are three blocks high with no hole at all: you get over them with a little parkour, up a lane of steps in front of the wall.

You play as a chunky little party-game runner (an original character), as tall as one block, who runs, jumps, flails and tumbles. The camera follows close behind and a little above, with a 70° field of view by default, so the runner and the walls look big on screen. Any block between the camera and the runner, or right in front of the camera, turns see-through so it never hides you.

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
| Camera | Move the mouse: the camera turns 360° around the runner | Drag anywhere away from the joystick and **JUMP** |
| Restart / menu | `R` / `Enter` / `Esc` on the pause and game-over screens | Buttons |

While you play, the cursor is hidden (pointer lock) and the mouse turns the camera all the way around the runner. Moving the mouse up and down tilts it between skimming the floor and looking almost straight down. If it turns too fast or too slow, change **Mouse sensitivity** in Settings (0.2× to 4×). Movement follows the camera, so `W` always runs away from it. `Esc` frees the cursor and pauses. If the cursor is free while you play, click the 3D view to take the camera again. After a game over, the camera slowly circles the spot where the run ended.

Touch controls appear automatically on touch devices. You can steer and jump at the same time with two thumbs, and turn the camera by dragging anywhere else on the screen.

## How the waves work

Each built-in wave is an 8×8 ASCII grid (your own layouts cover the whole map; see **Wave layouts** below). Every wave has its own block colour, different from the wave before it. Most waves are wall waves in the style of sweeping block-wall party games: one full-width wall per row, with holes and low parts, and gaps between walls. The layouts are original. Columns `A`–`H` are the lanes. Rows arrive in order **8 → 1**: row 8 reaches you first and row 1 last.

| Symbol | Meaning |
|---|---|
| `#` | Stack of 2–3 cubes: too tall to jump |
| `.` | Hole |
| `J` | Single cube: a jump gets you on top, and a running jump or a dive clears it |
| `M` | Moving crusher: rises and slams down; if it lands on you, you're bonked forward and dazed for a moment |
| `3` | Stack of exactly 3 cubes: a wall you can't jump |
| `S` | Climb lane: a 3-cube stack with steps in front of it (2 cubes high, then 1). Jump onto the low step, then the middle one, then onto the top, and drop down behind the wall. Climb lanes are drawn in a lighter colour |
| `X` | Spikes: a dark cube with spikes on every side but the bottom. You can't stand on it, and touching it knocks you backwards |
| `B b` | Bar: a low striped bar lying across two lanes (`B` is its left half, `b` its right). Hop over it; touching it knocks you backwards |

How contact works:

- **Front of an incoming wall:** it pushes you along with it. You can slide sideways along it freely into a hole, or run away from it. You can still jump while it shoves you, to the full height: against a single-block wall you sail up and land on top of it.
- **Side of a block:** solid. You stop against it.
- **Back of a wall:** solid too. If you catch up with a wall that has already passed you, you stop against it and move along with it.
- **Spikes and bars:** solid, and they knock you backwards with a short tumble (no control for under half a second). Coming at you, they throw you back toward the near edge; touch one from the side or from behind and you're thrown away from it. You can't stand on either. A bar is low (0.8 units), so a jump timed as it arrives, or a running jump, clears it. Get knocked off the edge and the run ends with **Knocked off the edge**.
- **Top of a block:** safe to stand on. A ridden block carries you toward the near edge, and you keep that momentum when you jump off. Every block is the same cube, and taller obstacles are whole cubes stacked on top of each other. Stacks can't be reached from the floor; climb onto them from a single block, or up the steps of a climb lane. While you climb you ride along with the wall, so climbing doesn't eat into the time before the next wall.
- **Dive:** press jump again in the air. You lunge forward in your steering direction (or the way you face) with a small hop and a low profile, covering about 6.4 units from the top of a jump, then do a short belly slide.

The run only ends if you **fall off the arena** (off the front or back edge: pushed off, ridden off or walked off) or **touch a laser fence** on the sides. Falling off means a long drop before the run is over, and walls teeter on the near edge for a moment before they fall, giving a rider time to jump off. A teetering wall stays solid until it tips into the void. The floor is a little slippery: you reach full speed in about 0.13 s and turn quickly, but glide a short way (under two units) when you let go. A wall hands you its momentum when it shoves you, and you bounce lightly off block sides. There's no gate: walls rise out of the platform right at the far edge.

The six patterns from the brief (Basic Corridor, Alternating Gaps, Double Corridors, Jump Challenge, Narrow Zigzag, Moving Obstacles) are included verbatim. Six wall waves (Wall Rush, Hop or Hole, Slider, Twin Walls, Crusher Wall, Last Gap) are picked more often than the rest. Six more grid patterns also unlock as the wave count grows: Hurdle Run, Staircase, Hop Scotch, Split Decision, Crusher Alley and The Gauntlet. Four climb-wall patterns (Step Up, Climb Wall, Summit and Sky Ladder) appear only on Normal and harder. Four more bring in spikes and bars: Bar Hop, Spike Fence, Bar Run and Spike Slalom.

The pattern engine parses each grid and rejects malformed or impossible patterns when the page loads. It then lays out every wave with a survivability solver:

- The arena width is sampled every 0.1 units, and each row is classified as free, needs a jump, climb the steps, or blocked for the player's hitbox. Wall sections and crushers count as blocked, so a wave never depends on riding, diving or crusher timing, and only a climb wall's steps ever ask you to climb.
- For each pair of consecutive rows, the solver works out how long the player needs to get from any position they could be in to the nearest safe spot in the next row. This accounts for acceleration, landing after a jump or a climb, and setting up the next jump or climb. Rows are then spaced so that much time always exists at the current speed, plus a reaction margin, and a climb wall is moved back by the length of its steps.
- Waves are spaced the same way, so the first row of the next wave is always reachable from wherever the last one could leave you.

A new wall appears at most once every 7 seconds on every level, and only one wave is on the map at a time: the next one starts at the far edge once every row of the previous wave has left over the near edge. Within a run the blocks get 5% faster every few waves, the reaction margin shrinks, harder patterns become more likely, and a pattern may arrive mirrored. The difficulty slider sets how all of that goes:

| Level | Start speed | 5% faster every | Reaction margin | Patterns | Mirrored from wave | Climb walls |
|---|---|---|---|---|---|---|
| Very easy | 5.6 units/s | 25 waves | ×1.6 | easiest only (rating 1–2) | never | none |
| Easy | 6.3 units/s | 20 waves | ×1.3 | rating 1–3 | 11 | none |
| Normal | 7 units/s | 20 waves | ×1 | all | 6 | now and then, from wave 5 |
| Hard | 7.7 units/s | 15 waves | ×0.8 | all, harder sooner | 3 | about every other wave, from wave 2 |
| Very hard | 8.4 units/s | 10 waves | ×0.65 | all, hardest sooner | 1 | most waves, from wave 1 |

Very easy, Easy and Normal open with the same three gentle waves. The arena is 12 lanes wide and 40 units long (12 × 20 squares of 2 × 2 units); the 8-column patterns are centred on it and their outer columns extend to the edges. The patterns are authored with the chessboard-style `A`–`H` / `8`–`1` grid below, but no lane letters or row numbers are drawn in the game.

### Adding a pattern

Append an entry to `PATTERN_DEFS` in `index.html`:

```js
{ id: 'my-pattern', name: 'My Pattern', minWave: 5, rating: 3, ascii: `
      A B C D E F G H
  8 | # # . . # # # # |
  ...
  1 | # # # . . # # # |` },
```

`minWave` is the earliest wave index (0-based) it can appear at. `rating` (1–5) steers how often it is picked at a given difficulty. Add `climb: true` to a pattern that uses `S` lanes so it only appears on Normal and harder. Invalid patterns are logged to the console and skipped.

## Skins

Pick an outfit under **SKINS** on the main menu. There are 30 original outfits: Classic, Ninja, Astronaut, Robot, Pirate, Chef, Royal, Wizard, Kitty, Bunny, Teddy, Dino, Viking, Cowboy, Knight, Swimmer, Propeller, Party, Super, Alien, Angel, Devil, Froggy, Unicorn, Shark, Snowy, Firefighter, Detective, Jetpack and Sporty. Each is a head, face and back item on the runner, built from simple shapes. Every outfit has six colours you can change: skin, top, bottom, hat, shoes and detail. **RANDOM** rolls new colours and **RESET** goes back to the outfit's own.

The runner shows off the outfit on a podium beside the arena; drag beside the panel to turn it. Some items move: capes and tails sway, propellers spin, wings flap and the jetpack fires while you're in the air.

## Block designer

Paint your own blocks under **BLOCKS** on the main menu. You get a loadout of 20 designs, each a 16×16 pixel block face shown on every side of the cube. The loadout starts with 20 starter designs you can paint over: Tile, Bricks, Crate, Checker, Hazard, Smiley, Heart, Star, Gem, Circuit, Dots, Ice, Lava, Stone, Gift, Target, Window, Neon, Cookie and Plain.

- **DRAW** paints cells (drag to paint a line), **FILL** floods an area, and **PICK** takes a colour from the design. **MIRROR** paints both halves at once, and **UNDO** (or Ctrl+Z) steps back. **CLEAR** paints the whole face in the current colour.
- Choose from 24 colours, or any colour with the rainbow swatch. **Template…** loads one of the starter designs into the slot, and **COPY** / **PASTE** copy a design from one slot to another.
- **In game** puts a design in the loadout the walls use. Each wave uses the next design that is in game, in slot order. With none in game, the walls use the classic look.
- **Wave colour** tints the design with each wave's colour; paint it in light tones for that. Without it the design keeps its own colours. Climb lanes are drawn a little brighter either way, and crushers keep their own look.
- The design shows live on a little stack of blocks on the podium beside the panel; drag there to turn it.

## Wave layouts

Arrange the walls yourself under **WAVES** on the main menu. You edit them from above: the camera flies up over the arena and the layout stands on it as real blocks. Your runner waits just off the near edge, and glowing arrows past the far edge show where the walls roll in from. The background walls pause while you edit. On a phone held upright the arena lies sideways so it fits above the panel.

You get 30 layout slots. A layout covers the whole map: every square of the checkered floor is a cell, 12 lanes across and 20 squares from the near edge to the far one (240 in all), and each square holds one block or one stack. The wave arrives exactly as you built it. It is one formation, with the rows one square apart as on the map, so blocks you put next to each other stay together: thick walls, corridors, mazes, staircases. The row nearest your runner is the front of the wave and reaches you first. Empty rows before the first block and after the last one are left out, and the wave still starts at least 7 seconds after the last wall of the wave before it.

Only the squares themselves can be built on; there is no space beside the outer lanes, because the laser fences stand right there. A row painted all the way across is a wall from fence to fence with no way around it. Built-in patterns copied in with **Start from…** and the oldest saved layouts have 8 rows. Their rows are spread over the map where the old editor showed them, two or three squares apart. Layouts saved when the map was 10 × 18 keep their rows, counted from the near edge, and the two new far rows start empty. Narrower rows are widened to all 12 lanes the way the game widens the built-in patterns: the outermost cell carries on to the edge.

- Brushes: **HOLE**, **1 BLOCK**, **2 BLOCKS** and **3 BLOCKS** (a stack of exactly that many blocks; you can jump onto or over 1 block), **CLIMB** (a 3-high wall with steps on the two squares in front of it, 2 and 1 high), **CRUSHER**, **SPIKES** (one square) and **BAR** (two squares side by side; at the right edge it fills the last two). Painting over either half of a bar removes the whole bar, and dragging the BAR brush lays bars two by two. Click or drag on the arena to paint; clicking a block paints its square, so you can paint on top of tall walls (clicking a climb step paints the square it stands on). A white tile shows the square you are about to paint. **MIRROR** paints both sides at once. **FILL** paints the whole touching area of the same kind with one click: on an empty layout that is the whole map. With **MIRROR** on it fills the mirror image as well. **FILL ALL** paints every square of the map with the current brush (with BAR, each row gets six bars; FILL lays bars two by two along each row of the area and leaves a lone square empty). There is **UNDO** (or Ctrl+Z) and **CLEAR**. **Start from…** copies any built-in pattern into the slot.
- Give each layout a name; it shows in the wave banner when it comes up.
- Nothing is checked or blocked. Any layout with at least one block is ready to play, even a completely filled map, and the status line counts the filled squares (out of 240). A full wall of 2 or 3 blocks can't be passed: it pushes you off the arena unless you climb it. A full wall of 1 block can be jumped. Since the wave arrives as built, you set the spacing yourself: leave empty rows between walls to give yourself time.
- The 8 pips under the wave counter fill up as the rows of your wave go past.
- **In game** mixes the layout in with the built-in waves. **Only my layouts** makes every wave one of yours, in slot order. The difficulty slider still sets the speed and reaction time.
- **TRY IT** starts a practice run with only that layout. Practice runs don't count for your personal best, and when the run ends **BACK TO EDITOR** takes you straight back.

## Settings and saved data

The Settings screen covers graphics quality (Low, Medium, High), field of view (70° by default), camera X and Y offset, mouse and camera sensitivity, joystick sensitivity and size, volume, sound effects, music and vibration. Settings (including the difficulty) are stored in `localStorage` under `blockdash.settings.v1`. The personal best is kept per difficulty: `blockdash.bestWave` for Normal and `blockdash.bestWave.1`, `.2`, `.4` and `.5` for the other levels. The chosen outfit and your colours are stored under `blockdash.skin.v1`, your 20 block designs under `blockdash.blocks.v1`, and your 30 wave layouts under `blockdash.layouts.v1`.

## Debugging

Add `?debug=1` to the URL to expose `window.BlockDash` (game state, world, player and the pattern solver) in the browser console.
