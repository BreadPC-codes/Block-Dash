# ROOST MX: motocross simulator

A browser motocross simulator built with HTML, CSS and plain JavaScript, using [Three.js](https://threejs.org/) r170 for rendering. The bike is simulated, not animated: real suspension, weight transfer, tyre grip, a clutch and gearbox, and a rider who shifts his weight. You ride it with a keyboard or with any controller the browser supports (Xbox, PlayStation and generic USB pads), with true analog throttle, brakes and steering.

## Running it

Open `index.html` in a desktop browser (Chrome, Edge or Firefox). There is no build step and nothing to install. The page loads Three.js from a CDN (jsDelivr, with unpkg as a fallback), so it needs an internet connection. The game code itself is plain `<script>` files, so opening the file straight from disk works.

You can also serve the folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/motocross/> (from the repository root) or <http://localhost:8000> (from inside `motocross/`).

Click or press any key on the title screen (browsers only allow sound after a click or key press). With a controller, press its A or ✕ button.

## What's in it

- **Main menu** with a 3D showroom: the bike turns on a lit turntable, the camera drifts around it, and you can drag to spin it.
- **Four bikes**: RX 125 (125cc 2-stroke), RX 250 (250cc 2-stroke), RF 250 (250cc 4-stroke) and RF 450 (450cc 4-stroke). They differ in torque curve, rev range, flywheel inertia, engine braking, gearing (6 or 5 speeds), weight, suspension spring rates and damping, brakes and handling. The bike selection screen shows their real numbers and a torque/power graph.
- **Three tracks**, all real 3D terrain:
  - *Willow Creek Practice*: a wide loop with flat corners, berms, rollers, small doubles and tabletops, in a valley you can ride all over.
  - *Steel City Supercross*: a night stadium with rhythm lanes (single, double or triple them), 15 whoops, a 20 m triple, on-offs, a step-up, tight rutted 180s and tuff blocks.
  - *Red Ridge National*: a 1.2 km outdoor track over hills (21 m of elevation change) with step-ups, a step-down, big tabletops, a 23 m double, off-camber sweepers, deep ruts, braking bumps and uneven ground.
- **Garage**: per-bike paint (plastics, five graphics styles, graphics colour, frame, seat, rims, number plates and race number) and shared rider gear (jersey, accent, pants, gloves, boots, helmet, helmet accent, goggle lens), shown on a rotatable 3D preview. A setup tab per bike: fork and shock spring rates, compression and rebound damping, rear sprocket (gearing) and steering response.
- **Four cameras**: chase, helmet (first person), trackside side camera and free orbit. They blend smoothly when you switch, react to jumps and lean, and can be adjusted for distance, height and sensitivity.
- **Sound**: the engine is synthesised live from exhaust pulses whose rate follows the RPM (one pulse per turn for the 2-strokes, one per two turns for the 4-strokes), with separate on-throttle and off-throttle sounds, 4-stroke deceleration pops and the rev limiter. Tyres, wind, skids, gear shifts, landings, bottoming and crashes are synthesised too, and a short procedural rock loop plays in the menus.
- **HUD**: speed, gear, RPM with a tachometer and shift light, lap timer with checkpoints, last and best lap, track name, minimap, throttle/brake/clutch/lean/body bars, and messages for resets, laps, crashes and controllers.
- **Settings** (saved in the browser): graphics quality, resolution scale, dynamic resolution, shadows, field of view, FPS counter, fullscreen, volumes, music while riding, assists, units, camera options, plus full keyboard and controller remapping with a live controller tester.

## Controls

| Action | Keyboard (default) | Controller (default) |
|---|---|---|
| Accelerate | `W` | Right trigger (RT / R2), analog |
| Front brake | `Space` | Left trigger (LT / L2), analog |
| Rear brake | `S` | X / □ |
| Clutch | `Shift` | A / ✕ |
| Lean left / right | `A` / `D` | Left stick ↔ |
| Rider forward / back | `↑` / `↓` | Left stick ↕ |
| Shift up / down | `E` / `Q` | RB / R1, LB / L1 |
| Change camera | `C` | Y / △ |
| Reset bike | `R` | B / ○ |
| Pause | `Esc` | Start / Options |
| Look around | `←` / `→`, mouse drag, mouse wheel to zoom | Right stick |

In the menus, use the mouse, the arrow keys with `Enter` and `Esc`, or the D-pad or left stick with A and B. LB and RB (or `Tab`) switch tabs, and left/right moves sliders.

Every keyboard key and controller binding can be changed under **Settings → Keyboard** and **Settings → Controller**. Keyboard keys ramp like a hand on a lever. Controller triggers and sticks are read as true analog values, with adjustable stick and trigger dead zones, steering, throttle, brake and camera sensitivity, camera inversion and vibration. The game detects controllers when you plug them in, shows a message when they connect or disconnect, and switches the on-screen button names (Xbox, PlayStation or generic) to the device you used last. Controllers that browsers report without the standard layout (Firefox on Linux, for example) get a layout with the triggers on axes, which you can remap.

## How the riding works

The physics lives in `js/physics.js` and runs at a fixed 500 steps per second.

- **Chassis**: one rigid body for bike and rider. The rider's centre of mass moves inside it (forward/back, up/down, sideways), so where you put your weight changes the load on each wheel, how easily it wheelies or stoppies, and how it lands.
- **Spinning parts**: the angular momentum of both wheels and the crankshaft is part of the simulation. Opening the throttle in the air spins the rear wheel up and lifts the nose; a dab of rear brake brings it down; and the spinning wheels' gyroscopic effect couples yaw and roll during a whip.
- **Suspension**: a raked telescopic fork and a swingarm on its pivot, each with a progressive spring, digressive compression and rebound damping, a top-out and a bottoming stop, solved implicitly against a radial tyre spring. Bikes squat, dive, soak up landings and can bottom out.
- **Rider's legs**: the rider's height above the bike is its own spring-damper. A hard landing compresses his legs before his muscles catch up, which softens the hit and stops the bike bouncing back up.
- **Tyres**: each wheel is a disk that touches the terrain (the contact can be on a jump face, a rut wall or a berm). Grip comes from a combined slip model (slip ratio and slip angle share one friction ellipse, with a peak and a lower sliding level) that depends on the surface (prepared dirt, loose dirt, ruts, grass) and on load. There is rolling resistance, and brakes can lock a wheel.
- **Engine and drivetrain**: torque curves per bike, a rev limiter, engine braking, a friction clutch (the lever, plus an optional automatic/anti-stall clutch), a sequential gearbox with neutral, shift time, over-rev protection on downshifts and stalling.
- **Steering**: you don't turn the bars directly. You tell the rider how far to lean and he counter-steers to get the bike there, the way real riders do. Asking for more lean than the dirt can hold, landing crossed up, or hitting ruts and bumps leaned over still puts you on the ground. Berms let you lean much further. At walking pace he steers directly and dabs a foot.
- **In the air**: body position pitches the bike, and holding a lean whips it (the bike lays over and the rear kicks out). A **scrub** is leaning hard into the face before the lip: the suspension's rebound pushes sideways instead of up, so you fly lower and land sooner.
- **Crashes**: you go down for landing too hard, landing sideways or leaned over, nosing into a face, casing hard, looping out, going over the bars, digging the bars or your head into the ground, lowsiding, highsiding, tipping over at a standstill or hitting trees, rocks, hay bales, tuff blocks or walls. The bike and rider then tumble on their own, and the bike resets after a few seconds, or straight away with `R` or B / ○, to flat ground just behind where you went down.

### Assists (Settings → Gameplay)

- **Automatic clutch** (on by default): slips the clutch at low revs so you never stall. Turn it off to stall the bike; pull the clutch to restart it.
- **Automatic gearbox** (off by default).
- **Traction control** (on by default), like the factory TC on modern MX bikes: it trims power when the rear wheel spins up.
- **Rider instinct** (Standard by default): the reflexes a real rider has without thinking. He shifts his weight against wheelies and stoppies, eases the throttle before looping out, eases the front brake when the rear goes light, keeps the bike's pitch in line with its flight path in the air, steers into a rear slide and only leans as far as the dirt and berm will hold. *High* makes these stronger. *Off* turns them all off for pure simulation, where a 450 will loop out in first gear if you pin it.

## Laps and records

A lap starts when you first cross the finish line and counts when you cross it again after passing every checkpoint. Resetting the bike during a lap means that lap won't count. Best laps are saved per track and bike.

## Performance

Under **Settings → Graphics** you can pick the quality preset (Low, Medium, High, Ultra), a resolution scale, and **dynamic resolution** (on by default). While you ride, dynamic resolution lowers the render resolution in small steps, never below half, when the frame rate drops below 60 fps (or below the display's refresh rate, if that is lower). It raises the resolution again when there is headroom. The FPS counter shows the current resolution.

How the game keeps the work down:

- **Bike and rider**: each is a single skinned mesh. Every part is bound to a bone (frame, steering, fork, wheels, swingarm, shock, limbs), and one material with a texture atlas carries all the colours. That is 4 draw calls including shadows, instead of about 190.
- **Terrain and track**: both are cut into chunks with three levels of detail. Chunks outside the view are skipped and far chunks use fewer vertices. The track keeps its full width resolution at every level, so no cracks can open; terrain tiles hang a short skirt to hide theirs.
- **Draw order**: the bike first, then track, props, terrain, and the sky last, so hidden pixels are rejected early and only sky that is actually visible gets shaded.
- **Shadows**: trees, rocks, hay bales and tuff blocks cast shadows from a shadow-only copy that holds just the instances near the bike. Static scenery is merged into one mesh per material and its matrices are frozen.
- **Low preset**: uses a cheaper ground shader with the same diffuse lighting and no specular.
- **Loading and pausing**: shaders compile in parallel while the track loads, where the browser supports it. A paused game draws the scene once instead of every frame.
- **Physics**: about 30–50% faster per step, with bit-identical results. The noise has flat gradient tables, the centreline search grid is pruned, terms with zero weight are skipped, and nothing is allocated per step.
- **HUD and effects**: the HUD only touches the page when a shown value changes, and moves its bars with CSS transforms. Particles that have died cost nothing, and new tyre marks upload only the piece just added.

On the outdoor track at High quality, a frame now draws about 290,000 triangles in about 80 draw calls. Before these changes it drew about 980,000 triangles in about 230 calls.

## Files

```
motocross/
  index.html          page, menus, HUD markup; loads Three.js and the scripts
  css/style.css       interface styles
  js/core.js          namespace, module loader, maths & storage helpers
  js/noise.js         seeded simplex noise
  js/bikes.js         the four bikes (engine, gearbox, suspension, brakes)
  js/track-data.js    track layouts and features
  js/track.js         terrain + track height function, berms, ruts, props, colliders
  js/physics.js       motorcycle physics and crash simulation
  js/input.js         keyboard, mouse & gamepad input with remapping
  js/settings.js      settings, garage and records (localStorage)
  js/audio.js         procedural engine, effects and music
  js/bike-model.js    the 3D bike and rider (IK limbs)
  js/world.js         sky, light, terrain & track meshes, props, stadium, showroom
  js/fx.js            dust, roost and tyre marks
  js/camera.js        chase, helmet, side and free cameras
  js/hud.js           in-game HUD
  js/ui.js            menus and navigation
  js/game.js          game states, main loop, laps, crashes and resets
```

The physics, terrain and bike files run under Node.js too, so the riding can be tested without a browser.
