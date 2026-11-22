# Roost MX — Motocross Simulator

A 3D motocross riding game built with **HTML, CSS, JavaScript, Three.js and Electron**.
Ride a motocross bike with a custom physics model (suspension, tire grip, engine and
gearbox, jumps, air control and physics-driven crashes) on three generated tracks, in
Free Ride or Time Trial, with keyboard or gamepad. Import your own bike models in the
garage and ride them.

Everything (bike, rider, tracks, textures, sounds) is generated in code, so the game
runs **fully offline** and needs no asset downloads.

![Main menu](docs/menu.jpg)

---

## Play instantly (no install)

Open **`play/index.html`** — double-click it and it starts in your browser (Chrome,
Edge or Firefox). It is a single self-contained file (about 1.7 MB) with the whole game
inside, so you can copy it anywhere. Your settings, best laps and imported bikes are
saved in that browser.

To regenerate it after changing the code: `npm run build:html`.

## Quick start

Requirements: [Node.js](https://nodejs.org) 18 or newer (with npm). A GPU with WebGL 2.

```bash
npm install
```

```bash
npm start
```

`npm start` bundles the game (`dist/game.js`) and opens it in an Electron window.

### Play in a browser instead

```bash
npm run serve
```

Then open <http://localhost:8765>. (After `npm run bundle` you can also open
`index.html` directly from disk in Chrome or Edge.)

## Building the Windows .exe

```bash
npm run build
```

Creates the installer **`release/Roost MX Setup.exe`** (choose install folder, desktop and
Start-menu shortcuts, uninstaller).

```bash
npm run build:portable
```

Creates the portable **`release/Roost MX.exe`** — a single file that runs without
installation.

```bash
npm run build:all
```

Builds both. Run these on Windows. On Linux/macOS the portable build works as-is, but
electron-builder needs [Wine](https://www.winehq.org/) to create the NSIS installer.

The app runs in its own window (no browser UI), starts maximized and switches to
fullscreen if that setting is on. **F11** or **Alt+Enter** toggles fullscreen at any time.

## Controls

Bike and rider are controlled **separately**, like in MX Bikes: steering turns and
leans the bike; *rider lean* moves the rider's body. **Counter-lean to turn faster:**
lean the rider to the *outside* of the turn (opposite to the way the bike leans) and
the bike lays down further under you with more grip — the turn gets roughly 20–45 %
tighter. Leaning into the turn just keeps the bike more upright. Forward/back moves
weight for wheelies, braking and pitch in the air; throwing the body left/right in the
air tilts the bike (scrubs).

Every action can be remapped for the keyboard **and** the controller in
**Settings → Controls** (two slots each). Click a slot — or select it with the
controller and press A — then press the key / button or move the stick or trigger.
Right-click, Delete or X clears a slot; Esc cancels; *Reset keyboard* / *Reset
controller* restore the defaults below.

| Action | Keyboard | Controller (Xbox layout) |
|---|---|---|
| Throttle | W | RT (analog) |
| Front brake | Space | LT (analog) |
| Rear brake | S | X |
| Steer / lean bike left, right | A / D | Left stick ← → |
| Rider lean left, right | ← / → | Right stick ← → |
| Rider lean forward, back | ↑ / ↓ | Left stick ↑ ↓ |
| Shift up / down | E / Q | RB / LB |
| Reset bike | R | A or View |
| Track marker: hold 3 s to set, tap to go back | ↓ (hold / tap) | (unbound - map it in Settings) |
| Change camera | C | Y |
| Look back | B (hold) | B (hold) |
| Camera left / right / up / down | (unbound) | D-pad |
| Pause | Esc | Menu (Start) |
| Fullscreen | F11 or Alt+Enter | — |

### Track marker

Practising a section? Stop where you want to start from and **hold ↓ for 3 seconds**
(with the wheels on the ground): a bar fills, then a flag marks the spot on the track and
the minimap. From then on a **quick tap of ↓** puts you back at the marker, standing
still and facing the same way - also straight after a crash. Holding ↓ remains *rider lean
back* (wheelies, back flips), and taps in the air are pitch corrections, so neither ever
teleports you. Setting a new marker replaces the old one; each track keeps its own for the
session. In a timed lap, going back to the marker makes that lap invalid. The marker has its
own binding in Settings → Controls if you would rather put it on another key or a
controller button.

### Whips and air control

In the air the same inputs become **whips** and **body English** — torque on the bike,
not an animation:

| In the air | Keyboard | Controller |
|---|---|---|
| Whip left / right (rear swings out, bike lays over) | A / D | Left stick ← → |
| Nose up / down (pitch) | W / S (throttle lifts the nose, rear brake drops it) or ↓ / ↑ | Left stick ↓ ↑ |
| Throw the body left / right (roll, scrub) | ← / → | Right stick ← → |
| Back flip / front flip: hold, let go once it comes round | ↓ / ↑ | Left stick ↓ / ↑ |

- The input builds up rider *effort* over a fraction of a second; effort becomes torque
  on the bike, and the bike keeps rotating on its own momentum after you let go. A tap
  is a small tweak, a held input a big, dramatic whip (with full assists a 0.45 s full
  input whips the bike ~38°, 0.8 s takes it to ~75°).
- Let go and the rider stops the rotation and straightens the bike gradually, working
  harder in the last moments before touchdown. A whip still held into the landing, or
  not brought back in time, lands crossed up or sideways — and crashes.
- The spinning wheels act as gyroscopes (yawing the bike also rolls it and vice versa;
  stronger at higher wheel speed), the bike weathervanes into the airflow when sideways,
  the front wheel turns back toward the direction of travel while the rear swings out,
  and the rider's upper body counter-rotates and counter-leans against the bike.
- A whip can be started on the last metres of the jump face: steering there partly turns
  the bike in the air instead of turning on the ground.
- Assists (Bike settings) decide how much the bike is straightened for you: *Full*
  brings it back on its own, *Low* partly, *Off* leaves it to you (counter-whip with the
  opposite input) — the same input gives a similar whip on every level.
- *Air control (whips)* in Bike settings scales the rider's strength in the air
  (50–150 %).
- **Flips**: a big jump (about 1.8 s of air or more) leaves time for a back flip (hold ↓)
  or a front flip (hold ↑). The bike keeps turning while you hold; let go once it is
  most of the way round. With assists on, the rider then finishes the rotation and lines
  the bike up for the landing - let go too late and it over-rotates and loops out.
- **F3** (or Settings → Graphics → *Physics debug overlay*, off by default) shows whip
  angle, pitch, roll, angular velocities, rider / recovery / gyro / aero torques, the
  efforts, the keyboard and controller inputs and the time to landing.

All whip tuning values live in one object, `WHIP` in `src/whip.js`.

Controller options: stick deadzone, steering sensitivity, invert rider forward/back,
and *linked brakes* (the front brake also applies some rear brake, on by default).
Generic (non-Xbox) controllers work too: their buttons and axes show up as
"Button n" / "Axis n" when you map them, and triggers that rest at -1 are detected
as full-travel triggers. Controllers are detected automatically, with an on-screen
message on connect and disconnect (the game pauses if the controller disconnects
while riding).

Menus: arrow keys, Enter and Esc, the mouse, or d-pad / left stick + A / B on a
controller (these menu controls are fixed).
Free camera: drag to look, scroll to move, I/J/K/L to fly, U/O down/up, Shift = faster.
In the other cameras, dragging the mouse orbits the view and the wheel changes distance.

## Game modes and tracks

- **Free Ride** — ride anywhere on the map with no time limit, jump, crash and reset.
  An optional lap timer runs when you follow the track (turn it off in
  Graphics → *Lap timer in Free Ride*).
- **Time Trial** — 3-2-1 countdown and gate drop, lap timer from the finish line,
  ordered checkpoints with split times against your best lap, invalid-lap detection
  (cuts, wrong way, leaving the track). Best laps and splits are saved on this computer.

| Track | Type | Length |
|---|---|---|
| Ridgeback Valley | Outdoor motocross | 1.4 km |
| Pine Hollow Practice | Compact practice track | 0.7 km |
| Dune Coast | Sand track by the sea | 1.0 km |
| Big Air Line | Point-to-point jump line | 2.7 km |

**Big Air Line** is one dead-straight dirt strip with 28 big jumps in a row — tables,
doubles, triples and a step-up, 2.2 to 4.2 m tall with gaps up to 38 m and up to
~2.4 s of air time. The jumps are sized so their ideal takeoff speeds climb smoothly
from about 47 to 83 km/h: carry your speed from one landing into the next jump. A
run starts at the gate and the clock stops at the far end; a few seconds after the
finish you are taken back to the start. Every jump on it is checked with the real bike
physics (`node tests/jump-tuner.mjs`) for a safe speed window and a mid-ramp landing.

Tracks include a start straight with a working starting gate, bermed corners, doubles,
a triple, tabletops, a step-up, a rhythm section, whoops, rollers and elevation changes,
plus banners, tire walls, hay bales, rocks, bleachers with spectators, a timing tower,
pits and distant mountains or dunes. The riding surface itself is smooth (no ripples or
braking bumps), and there are no fences, trees, bushes, grass tufts or distance haze.
Dirt, grass, gravel and sand each have their own grip and rolling resistance.

### Importing MX Bikes tracks (.pkz)

On **Track Select** choose **Import a track** (or drop `.pkz` files onto the list). Roost MX
reads from an MX Bikes track package:

- **the terrain** — the `.trh` collision heightfield, the same ground the game itself rides
  on (up to 8193 samples a side; very large ones are kept at 2049 a side), so every jump,
  berm, rut and hill has its real shape and height;
- **the track line** stored in the `.trh` — used for the riding line, the minimap, lap
  timing with checkpoints and safe respawns (jumps are found from the terrain, so a crash
  never puts you back in a jump's gap);
- **the race data** (`.rdf`) — finish line and starting position;
- **the name and author** from the `.ini`.

Distribution packs that nest a `*_server.pkz`, and work-in-progress folders with the
heightmap sources (`.hmf` + 16-bit `.raw`), work too. Packages may hold several tracks;
each one gets its own import dialog.

**Scale.** The import dialog has a scale slider from 25 % to 300 %. Scaling is uniform —
width, length and height together — so the track keeps its proportions. **100 % is the
real size** from the file: MX Bikes and Roost MX both work in metres, so at 100 % the
track is in proportion to the bike. The dialog shows the map size, lap length and height
range at the chosen scale, plus a preview with a 50 m scale bar; jumps need roughly √scale
times the speed. Change it any time: click the track's card → *Scale & ground* (best laps
are reset, they were set at the old size). *Ground* chooses what the whole map is made
of: dirt, grass or sand (grip and look; the land around the map matches it).

**Shown as it is:** the terrain comes in exactly as the file has it, all in the ground you
picked - Roost MX adds no track, start gate, finish arch, banners, grandstands, fences or
other props to it (the file's track line is still used, unseen, for timing, the minimap and
respawns). Small bumps and ripples under about 1.5 m are smoothed out; jumps, berms and
hills keep their shape. **What does not come in:** the scenery models (`.edf`), the terrain
graphics (`.map`) and the track's textures and objects. A track without a centre line can
still be ridden in Free Ride
(spawning on the flattest ground near the middle). Protected (encrypted) packages are not
plain ZIP archives; they are refused, never decrypted. Imported tracks are stored on this
computer (IndexedDB, about 8 MB each); the `.pkz` itself is never modified. Please respect
track authors' licences: import tracks you have downloaded for your own riding.

## Features

**Physics** (`src/physics.js`, 240 Hz fixed step, frame-rate independent)
- 6-DOF rigid body for bike + rider with gravity, aero drag and rolling resistance.
- Wheel contact on the heightfield with edge detection for lips, steps and crests.
- Progressive spring + compression/rebound damping per wheel, bottoming cone,
  tire compliance; the rider's legs are a sprung mass that soaks up impacts.
- Combined-slip tire model (slip ratio and slip angle share one friction circle),
  tire relaxation, surface-dependent grip. Wheelspin, rear slides, locked-wheel skids.
- Engine with a torque curve, auto clutch, rev limiter, engine braking and a 5-speed
  gearbox (automatic or manual).
- Lean-to-steer bike model: the bike leans toward a target based on input, speed and
  available grip (including berm banking); the front wheel steers to balance the lean.
  Front and rear brakes with weight transfer, stoppies, wheelies, countersteering.
- Separate rider body: the rider's weight moves fore/aft and across the bike (up to
  28 cm), shifting the combined centre of mass, and the bike balances around that
  combined centre. Counter-leaning (body to the outside, weight on the outside peg)
  lays the bike down under the rider, adds grip and tightens the turn; hanging off into
  the turn keeps the bike more upright; body lean alone does not steer.
- High grip: knobby tyres bite hard into the dirt (dirt grip 1.55, sand 1.3, grass and
  gravel 1.2) and keep ~85 % of their grip when they do slide, so the bike is planted
  rather than slippery. *Tire grip* in Bike settings scales it from 60 % to 160 %.
  The steering compensates for lean angle, so a leaned bike turns as tightly as its
  lean demands (~1.25 g steady cornering on dirt with full assists).
- **Whips and air control** (`src/whip.js`): torque-based whips with rider effort
  build-up, angular momentum, gyroscopic coupling of the spinning wheels, aerodynamic
  weathervaning and side drag, per-axis damping, soft limits, recovery that stops the
  rotation and straightens the bike (harder just before touchdown, momentum preserved),
  whips set up on the jump face, the front wheel steering back toward the direction of
  travel, and the rider's upper body as a separate counterbalancing spring-damper.
  Landings account for the bike's remaining whip and roll rate. Body English pitches
  (forward/back) and rolls (left/right) the bike; throttle/brake pitch it too.
- Crashes come from the physics: handlebars/head/fenders touching the ground, landing
  leaned or sideways, nose-diving, casing a jump, front-end tucks from overloading the
  front tire (e.g. braking hard while leaned), and hitting obstacles. The rider
  separates and tumbles as a ragdoll; reset with R / A (or your binding) or automatically.
- **Landings**: with assists the rider levels the bike in the air and, coming down,
  lines it up with the slope it is about to land on (a few degrees nose-up so the rear
  touches first), keeps the rear wheel near road speed so it does not land spinning,
  and eases the front brake before the rear lifts (anti-lift).
- **Rider assists** (Full / Low / Off): wheelie and stoppie control, traction control,
  brake modulation when leaned, grip-aware lean and landing assist. Off = raw sim (only
  the rider's instinctive roll-off before looping a wheelie or going over the bars).

**Visuals** — procedural bike with spoked wheels, knobby tires, USD forks, swingarm,
linkage shock, exhaust, plastics and number plates; rider with helmet, goggles, jersey,
gloves, pants and boots posed by two-bone IK each frame (standing/sitting, leaning,
weight shifting, foot dab in corners, absorbing landings). Dirt roost, dust, landing
bursts and tire marks. Sky with clouds, sun shadows, image-based lighting; no distance
haze, so far hills stay crisp.

**Cameras** — Chase, Close chase, Helmet (first person), Free camera; look back;
smooth transitions; terrain collision avoidance.

**HUD** — speed (km/h or mph), gear and gearbox mode, RPM bar with shift light, lap,
current/best/last lap, split delta, airtime, crash message, minimap, optional FPS.

**Audio** (Web Audio, procedural) — single-cylinder engine synthesized in an
AudioWorklet (pitch and tone follow rpm and load), wind, tire skids, roost, landings,
crashes, gear shifts, countdown, checkpoint and menu sounds. Master/engine/effects volume.

**Settings** (saved automatically) — steering sensitivity, engine power, suspension
stiffness and damping, front/rear brake strength, tire grip, rider assists, gearbox, camera
sensitivity and distance, controller sensitivity and deadzone, bike color and race
number, keyboard and controller bindings, graphics quality, render scale, dynamic
resolution, anti-aliasing, fullscreen, speed units, minimap, FPS, volumes.

**Graphics presets** — Low: no shadows, 75% render scale, fewer props, coarser
terrain, no anti-aliasing. Medium: shadows, full render scale. High: 2K soft shadows,
up to 1.5× render scale on high-DPI screens, full-detail terrain near the track.
**Dynamic resolution** (on by default) lowers the render resolution only while the
frame rate is below 60 FPS (or the screen's refresh rate) and raises it again when
there is headroom; **Render scale** sets its maximum. **Anti-aliasing** can be Auto
(per preset), On or Off and applies after a restart. *Show FPS* displays the frame
rate, current resolution, draw calls and triangles.

**Performance** — the renderer is built to keep draw calls and per-pixel work low:
the bike and the rider are one skinned mesh each (one draw call), trackside props are
merged into a few batches, rocks/tyre walls/hay bales/crowd are packed every frame
into one instanced draw per level of detail with view and distance culling, terrain
chunks switch between three levels of detail with the camera distance, the splat
shader skips absent layers and distant detail, the sky is rendered once into a cube
map, and rough surfaces get their ambient light from spherical harmonics instead of
environment-map lookups. Compared with the first release this is ~4× fewer draw calls
and ~3.5× fewer triangles per frame, and 2–3× less rendering time at the same preset
(measured with `tests/perf.cjs`).

## Garage and custom bikes

Open **Garage** from the main or pause menu. Drag to rotate, scroll to zoom.

- **Bikes** — the procedural Roost 450 plus every bike you imported; pick the active one.
- **Paint** — red, blue, green, black, white, orange, yellow or any custom color, and
  your race number. For imported models, tick which materials take the paint color.
- **Import** — choose files or drag them onto the window:
  - **GLB (recommended)** and **GLTF** (select the .gltf with its .bin and texture files,
    or put them in a .zip). Materials, textures, hierarchy and animations are kept.
    Draco- and Meshopt-compressed GLBs are supported.
  - **OBJ** (+ .mtl and textures; select them together), **FBX** (FBX 7.x binary or
    ASCII, via the three.js FBX loader — very old FBX versions are not supported), and
    **ZIP** archives of any of these.
  - **PKZ** packages (see below).
- **Adjust** — scale (log slider, so centimetre and millimetre models work), position
  X/Y/Z, rotation X/Y/Z, rider offset and visibility, model animation; *Auto-fit to
  wheels*, *Reset adjustments*, *Save configuration*, *Apply & use*.
- **Parts** — assign the bike root (everything outside it, such as a stand or ground
  plane, is hidden), front wheel, rear wheel, steering assembly, handlebar, front
  fork (sliding part), swingarm/rear suspension and rider attachment point. Parts are
  auto-detected from names (e.g. `wheel_front`, `Rear_Tyre`, `fork`, `swingarm`, also
  some German/French/Italian/Spanish names) or by geometry (two disk-shaped parts at the
  ends of the model). You can also pick parts by clicking the model or from the node
  list. *Preview motion* animates steering, suspension and wheel spin to check it.

When you ride an imported bike it is driven by the same physics as the procedural one:
its wheels spin and follow the suspension, the steering parts turn around the steering
axis, the fork slides, the swingarm pivots, and the whole bike leans, pitches, jumps and
lands with the physics body. Imported bikes and their settings are stored on this
computer (IndexedDB).

### About .pkz files (MX Bikes mods)

`.pkz` is the package format used by PiBoSo games such as MX Bikes. Roost MX opens a
.pkz as a ZIP archive and lists everything inside it in an import report:

- If the package contains a **GLB, GLTF, FBX or OBJ** model, it is extracted and loaded.
- Bike meshes in MX Bikes mods are normally stored as **`.edf`** files, and paints as
  **`.pnt`**. These are proprietary, undocumented PiBoSo formats. **Roost MX cannot read
  them** and says so in the report; it never pretends such a package loaded.
- If the file is not a ZIP container (for example encrypted), the report says that too.
- Track packages are imported from the track list instead (see *Importing MX Bikes tracks*);
  the garage recognises them and says so.

To ride a bike from such a mod you need the model in an open format: get the source
model from its author (most are made in Blender or 3ds Max) or use your own model, then
export it from Blender with *File → Export → glTF 2.0*, format *glTF Binary (.glb)*,
*+Y Up*, *Apply Modifiers*, with materials/images included. Naming objects like
`wheel_front`, `wheel_rear`, `fork`, `handlebar` and `swingarm` makes the setup
automatic. Please respect mod licences: many do not allow extracting, converting or
redistributing their models.

## Project structure

```
RoostMX/
  index.html, styles.css        UI shell and styling
  electron-main.js              Electron main process (app:// protocol, window, IPC)
  electron-preload.js           safe bridge: fullscreen, quit
  package.json                  scripts and electron-builder config
  src/
    main.js                     game states, main loop, ride logic, effects
    physics.js                  bike physics, engine, crashes, ragdoll
    zip-reader.js               random-access ZIP / PKZ reader (stored, deflate, ZIP64)
    mxb-track.js                MX Bikes track packages: .trh, .rdf, .ini, .hmf + .raw
    imported-track.js           imported tracks -> heightfield + track at a chosen scale
    whip.js                     whips / air control (all tuning values in WHIP)
    bike-geometry.js            shared bike dimensions (physics and visuals)
    bike.js                     procedural bike model and its animation
    bike-importer.js            GLB/GLTF/FBX/OBJ/PKZ import, part detection, binding
    rider.js                    rider model, IK posing, crash pose
    track.js, tracks.js         track layout builder, features, terrain generation
    heightfield.js              terrain data and surface types
    terrain-render.js           chunked LOD terrain and splat shader
    environment.js              sky, lights, vegetation, trackside props, colliders
    colliders.js                static collision shapes
    camera.js                   camera modes
    controls.js, controller.js  keyboard and gamepad input
    audio.js                    procedural audio
    particles.js                roost/dust particles and tire marks
    timing.js                   lap timer and checkpoints
    ui.js                       menus, settings, HUD, minimap
    garage.js                   garage scene and import workflow
    settings.js, storage.js     saved settings, records and imported bikes
    textures.js, util.js        procedural textures, math helpers
  assets/                       fonts (OFL) and icons
  scripts/                      bundler, icon generator, track analyzer
  tests/                        physics, timing, autopilot and browser tests
```

## Tests

```bash
npm test
```

Physics checks (rest, acceleration, braking, cornering, jumps, crash cases, rider lean:
counter-leaning vs neutral vs hanging off, tilting the bike in the air, grip).

```bash
node tests/whip-sim.mjs
```

Whips on a big double: small vs big inputs, symmetry, momentum after release, bounded
angular acceleration, soft limits, straightening before touchdown, a whip held into the
landing crashing, assist levels, the Air control setting, W / S / stick pitch, and front /
back flips that come round and land (and are never mistaken for whips).
`node tests/turn-radius.mjs` prints turn radius by speed for each rider position.

```bash
node tests/timing-test.mjs
```

Lap timer: laps, splits, cut / wrong-way / off-track detection.

```bash
npm run test:autopilot
```

A simple autopilot rides every track headless and reports crashes and lap / run times.

```bash
node tests/jump-tuner.mjs jumpline
```

Rides every jump of a track with the real physics at takeoff speeds from 10 to 28 m/s
and reports the safe speed window and the sweet spot (mid-ramp landing) of each.

```bash
node tests/track-import.mjs
```

MX Bikes track import: `.trh` heights and centre line, race data, orientation check,
scaling (proportions), the riding line on dirt, lap timing and a physics ride on the
imported track at 100 % and 200 %, nested server packs, heightmap sources and the error
messages. The synthetic test packages come from `node tests/make-mxb-fixtures.mjs`
(no MX Bikes content is included); `tests/track-import.cjs` runs the same import through
the game's UI in a browser.

Browser tests (`tests/smoke.cjs`, `tests/flows.cjs`, `tests/gamepad.cjs` — virtual
controller, rider lean, button remapping — `tests/whip.cjs` — keyboard and controller
whips and a keyboard back flip on the Big Air Line, the F3 overlay, rider counterbalance —
`tests/marker.cjs` — setting a track marker and going back to it — and
`tests/perf.cjs <low|medium|high>`, a
frame-time / draw-call benchmark) and the Electron smoke test
(`tests/electron-smoke.cjs`) use [Playwright](https://playwright.dev); start
`npm run serve` first. `node tests/make-fixtures.mjs` regenerates the importer
test files in `tests/fixtures/`.

## Troubleshooting

- **Black screen / "Could not start"** — the game needs WebGL 2. Update your graphics
  driver. On laptops, make sure the app uses the dedicated GPU.
- **Low frame rate** — keep *Dynamic resolution* on, lower *Render scale*, turn
  *Anti-aliasing* off, or use Graphics → Low / Medium. On first launch the game picks
  a preset from your GPU (integrated graphics start on Medium). *Show FPS* tells you
  the current frame rate and resolution.
- **No sound** — click or press a key once (browsers only start audio after input) and
  check the Audio volumes.
- **Controller not detected** — press any button on it; Windows browsers only expose a
  pad after an input.
- Developer tools in the desktop app: Ctrl+Shift+I.

## Known limitations

- PiBoSo `.edf` meshes and `.pnt` paints inside `.pkz` files are not supported (see above).
- Imported MX Bikes tracks bring their terrain, track line and race data, not their
  scenery, terrain textures or objects (see *Importing MX Bikes tracks*).
- Imported models are fitted to the built-in physics geometry (1.48 m wheelbase); the
  physics does not change with the model's dimensions or mass.
- Rear shock and linkage parts of imported models move with the swingarm rather than
  compressing.
- No AI opponents or multiplayer.
- The NSIS installer has to be built on Windows (or with Wine).

## Licences

The MX Bikes `.trh` terrain layout is implemented from the description in the
MIT-licensed [mxb-app](https://github.com/Frostn1/mxb-app) project (no code copied).

Code: MIT. Three.js: MIT. Electron: MIT. Barlow and Barlow Condensed fonts: SIL Open
Font License 1.1 (`assets/fonts/OFL-LICENSE.txt`). All sponsor names on trackside
banners are fictional.
