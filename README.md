# Block Dash

A 3D obstacle survival game in one file: `index.html` (HTML, CSS and JavaScript, with [Three.js](https://threejs.org/) r170 loaded from a CDN). You share the arena with computer-controlled rival runners, and you can punch them. With the little server next to it, `server.js`, everyone on your Wi-Fi can play together in rooms (see [Rooms](#rooms-play-together-on-your-wi-fi)).

Walls of cube blocks sweep across a small floating 12-lane arena with a slightly slippery checkered floor, one wave at a time and at most one new wall every 7 seconds. Slip through the holes, jump or dive over single cubes, or climb on top and ride. A wall that catches you pushes you toward the edge, so slide into a hole before you run out of floor. The always-on laser fences stand right beside the outer lanes, so there is no way around a wall at the sides: every wall reaches from fence to fence. Every wave you fully survive adds one to the **WAVE SURVIVED** counter.

The main menu is a lobby: your runner stands on a podium just off the near end of the arena, with the walls rolling in behind it. Drag across the lobby to spin your runner and tap it to see your emotes one after another; the plate underneath names its outfit. **CUSTOMISE** (skins and emotes), **BLOCKS**, **WAVES** and **ROOMS** (play together on your Wi-Fi) are down the left, **?** (How to play) and the gear (Settings) are at the top right, and your best, the difficulty, the game mode switch and **PLAY** are on the right. On a phone held upright everything sits above and below your runner instead, with the four tiles in two rows.

**Game mode:** the switch just above **PLAY** picks how a run goes. Your choice is saved.

- **REGULAR:** the classic game. One fall off the arena (or one touch of a laser) and the run is over.
- **RESPAWN:** a fall or a laser doesn't end the run. The camera stays on the spot for a moment ("FELL OFF!" or "ZAPPED!"), then you drop back in at the start ("BACK IN!") inside the cyan bubble: for 1.6 s nobody can punch, tackle or hug you. Rivals come back too, at their spots, 2.2 s after they go out. The **FALLS** chip counts your falls in place of your best, and a respawn run never counts for your personal best: play as long as you like and leave from the pause menu. Practice runs of your own wave layouts follow the switch too.

Pick a **difficulty** on the main menu with the slider, from Very easy to Very hard. On Normal and harder, some walls are three blocks high with no hole at all: you get over them with a little parkour, up a lane of steps in front of the wall.

You play as a chunky little party-game runner (an original character), as tall as one block, who runs, jumps, flails and tumbles. The camera follows close behind and a little above, with a 70° field of view by default, so the runner and the walls look big on screen. Any block between the camera and the runner, or right in front of the camera, turns see-through so it never hides you.

## Running it

Open `index.html` in a modern browser (Chrome, Edge, Firefox or Safari, desktop or mobile). There is no build step and nothing to install.

The page needs an internet connection to fetch Three.js (from jsDelivr, with unpkg as a fallback) and its web fonts. You can also serve the folder locally:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Windows: BlockDash.exe

On Windows the whole thing comes as one program, **BlockDash.exe**: the game, the rooms server (see [Rooms](#rooms-play-together-on-your-wi-fi)) and the 3D engine, with nothing to install and no internet needed. Download it from the [latest release](https://github.com/BreadPC-codes/Block-Dash/releases/latest/download/BlockDash.exe) and double-click it:

- A black window opens with the addresses to play at and the rooms PIN, and the game opens in a window of its own (Microsoft Edge's app window, or your browser if there's no Edge).
- Everyone else on your Wi-Fi opens the Wi-Fi address it shows (like `http://192.168.1.20:8080`) on their phone, tablet or computer, and you all meet under **ROOMS**.
- The first time, Windows may say it protected your PC, because the exe isn't code-signed: choose **More info**, then **Run anyway**. If the firewall asks, allow it on **private networks**, or nobody else can join.
- Close the black window to stop it. Opened again while it's still running, it just opens the game again.
- If port 8080 is taken, it uses the next free one and says so. The [server options](#switching-the-rooms-off-and-on) work here too (`set PORT=9000` in a Command Prompt, then `BlockDash.exe`), and `BlockDash.exe --no-open` starts it without opening the game.

Every change to `main` builds a new BlockDash.exe on GitHub (`.github/workflows/windows-exe.yml`) and puts it on the Releases page. To build it yourself, on any computer with Node.js 20.12 or newer (22 recommended):

```bash
node tools/build-exe.mjs
```

That writes `dist/BlockDash.exe`. It's a Node.js [single executable application](https://nodejs.org/api/single-executable-applications.html): the Windows build of the Node.js you run it with (downloaded from nodejs.org and checked against its published checksums, unless you build on Windows) with `server.js` inside as its program and `index.html` and Three.js (from npm) as its files, plus Block Dash's icon and name. `--target linux` builds the same thing for Linux (`dist/blockdash-linux`).

## Rooms: play together on your Wi-Fi

Everyone on the same Wi-Fi can play in one room, each on their own phone, tablet or computer. One computer runs the server that comes with the game: on Windows that's just [BlockDash.exe](#windows-blockdashexe); anywhere else it's `server.js`, which needs [Node.js](https://nodejs.org/) 18 or newer and nothing else (no `npm install`, no internet of its own).

1. Put `server.js` next to `index.html` and, in that folder, run:

   ```bash
   node server.js
   ```

2. It prints where to open the game. On that computer it's `http://localhost:8080`. On every other device it's the Wi-Fi address it prints, like `http://192.168.1.20:8080`. If another device can't open it, the computer's firewall is probably blocking it: allow Node.js on private networks.
3. On each device, open **ROOMS** in the lobby and type your name. One of you presses **HOST A ROOM** and the others **JOIN** it from the list. A room holds up to 8 players.
4. The host picks the difficulty and the mode and presses **START**. Everyone counts down together and gets GO at the same moment.

In a round:

- **The same walls for everyone.** The server gives each round a seed, and each device builds the walls from it, in step: the round runs on the server's clock, in fixed steps, so every screen shows the same walls in the same place. Rooms use the built-in patterns only (your own wave layouts stay out of them); each device draws the walls in its own block designs.
- **You see everyone.** Each device sends where its runner is and what it's doing about 20 times a second. Everyone else is drawn from that, in their own outfit with their name over their head, and moved on at their own speed between messages, so they keep up with the walls.
- **Fights work across devices.** Punches and Super Punches, tackles, the spatula, hugs, uppercuts and shoves are settled on the device of whoever throws them, and the one they land on is flung (or picked up) on their own device. A taunt still shrugs everything off. Glass that someone smashes is gone for everyone.
- **REGULAR:** one fall and you're out. The camera stays on the spot for a moment, then follows someone still in: ◀ ▶ at the bottom (or the arrow keys) switch who you watch. The last one standing wins ("YOU WIN!"); the round ends a moment later (or once everyone is out).
- **RESPAWN:** fall off and you drop back in at your spot, inside the bubble. The round goes on until the host ends it from the menu (**END THE ROUND**). The fewest falls wins, then the most knock-outs.
- **The round doesn't pause.** Esc (or the pause button) opens a menu over it, but the walls keep coming: **LEAVE THE ROOM** takes you back to ROOMS.
- **Knock-outs:** if someone goes out within a couple of seconds of your punch, tackle, swat, hug or shove, it's your knock-out: the feed says so ("You knocked out BO") and it counts in the results.
- **Results:** at the end everyone is back in the room with the results (waves, time or falls, and knock-outs), and the host can start the next round straight away. Rounds in rooms never count for your personal best.

### Switching the rooms off and on

The bar at the top of ROOMS shows whether the rooms are on, how many players are online, and the address the others open. The switch on its right turns the rooms off and on for everyone, from any device:

- On the computer running the server it just works, and the bar there shows the server's **PIN**.
- On any other device it asks for that PIN the first time (the server also prints it when it starts) and remembers it for next time.
- Off, every room closes, everyone in a room is sent back to ROOMS ("The rooms were switched off."), and nobody can host or join. The game page itself still loads from the server, so the rooms can be switched back on from any device.

The server's options are environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | The port to serve on. |
| `BLOCKDASH_PIN` | a new random 4-digit PIN every start | Your own PIN (4 to 8 digits). |
| `BLOCKDASH_START_OFF` | not set | `1` starts the server with the rooms off. |
| `BLOCKDASH_TRUST_LOCAL` | `1` | `0` asks for the PIN on the server's own computer too. |

For example, `PORT=9000 BLOCKDASH_PIN=2468 node server.js` (in Windows PowerShell: `$env:PORT=9000; $env:BLOCKDASH_PIN=2468; node server.js`). Press Ctrl+C to stop the server.

The server only serves `index.html`, the rooms, and its own copy of Three.js if it has one (BlockDash.exe does; for `server.js`, put `three.module.min.js` in a `vendor` folder next to it). With that, nobody needs the internet to play; without it, each device loads Three.js from the internet as usual. The fonts always come from the internet, with built-in ones in their place offline. Use it on a network you trust: anyone on it can open the game and join a room, and the PIN only guards the switch.

## Controls

| | Desktop (default keys) | Touch (phones and tablets) |
|---|---|---|
| Move | `W A S D` or arrow keys | Virtual joystick, bottom-left |
| Jump | `Space` | **JUMP** button, bottom-right |
| Dive | `Space` again in the air, after a jump | Tap **JUMP** again in the air, after a jump |
| Punch | `F`, or left click while the cursor is hidden | **PUNCH** button, left of **JUMP** |
| Super Punch | Punch during a dive (or the belly-slide right after it) | The same, with **PUNCH** |
| Emotes | `1`–`4` play your four emotes (or click their chips over **PUNCH** when the cursor is free) | **EMOTE** button, above **JUMP**, then tap one of your four |
| Pause | `Esc` or `P`, or the ❚❚ button | ❚❚ button |
| Camera | Move the mouse: the camera turns 360° around the runner | Drag anywhere away from the joystick and **JUMP** |
| Restart / menu | `R` / `Enter` / `Esc` on the pause and game-over screens | Buttons |

Every keyboard control can be changed: **Settings → CHANGE KEYS** (see **Changing the keys** below).

While you play, the cursor is hidden (pointer lock) and the mouse turns the camera all the way around the runner. Moving the mouse up and down tilts it between skimming the floor and looking almost straight down. If it turns too fast or too slow, change **Mouse sensitivity** in Settings (0.2× to 4×). Movement follows the camera, so `W` always runs away from it. `Esc` frees the cursor and pauses. If the cursor is free while you play, click the 3D view to take the camera again. After a game over, the camera slowly circles the spot where the run ended.

Touch controls appear automatically on touch devices. You can steer and jump at the same time with two thumbs, and turn the camera by dragging anywhere else on the screen.

## Punching and rivals

**Punch.** The arm pulls back and shoots out. Anyone inside the fist's reach while it is out gets hit once, and is flung the way the punch goes. The reach is generous: up to about 2.5 m ahead (centre to centre), 1.3 m to either side, and high enough to catch someone in the middle of a jump. You punch the way you are running, or the way the camera looks if you are standing still. A punch works standing, running and jumping, and it never changes how you move. After a punch there is a short cooldown (0.55 s), shown by the **PUNCH** meter in the corner (or the sweep on the touch button). A press up to 0.12 s before you're ready is remembered, and holding the key doesn't punch faster.

**Super Punch.** Punch during a dive, or during the belly-slide right after one, and it becomes a Super Punch. The dive carries on at full speed: nothing about your movement changes, the fist leads, and its reach turns with your movement, so it stays out in front of you in the air and close to the ground. It hits harder than a normal punch for the same momentum (see below), with a bigger hop, and its reach is longer still. It ends in a gold burst and a shockwave. You keep going after it connects.

**Momentum.** Every runner has a hidden momentum meter: it builds up as you run (about 6 after half a second, nearly full, 9.5, after two) and drains quickly when you slow down or stop (gone in about half a second). The more momentum you carry into a punch, the way the punch goes, the farther it flings someone. A point-blank punch from a standstill only knocks them back about one square (2 m); after a short run-up about 1.5 squares; at a full run about 2.5 squares (5 m); and a Super Punch out of a dive about 3.5 squares (7 m). So to punch someone into a laser, take a run at them, or knock them down and shove them in.

**Flung.** Whoever a punch hits flies backwards, tumbling and facing whoever hit them, with no control until they land. They land on their back with dizzy stars round their head and lie there: 2 s after a punch, 2.4 s after a Super Punch, 1.6 s after a tackle (the last third of a second getting up). A rival's punch keeps you down for less (0.8 s), so a knockdown doesn't cost you the run. Nobody can punch them again while they're flying or lying there, or for 0.3 s after they're up, so nobody can be juggled. Spikes and bars still only knock you back a short way.

**Shove.** Someone lying knocked down can't be punched, but they can be pushed: walk or run into them and they slide along the floor ahead of you, as fast as you push and a little further when you stop. Punch a rival toward a laser fence, run after them and shove them into it (or off the end of the arena): the knock-out is yours. (Rivals don't push you about while you're down.)

You can't punch through blocks: a wall or a glass block between you and someone stops the punch, but a knee-high bar doesn't. Every hit is checked 120 times a second against the reach swept since the last check, so speed never lets a punch skip through someone.

**Rivals.** Set **Rival runners** in Settings, from Off to 5 (3 by default). Each wears a random outfit and has its name over its head. They play by the same rules as you: they head for the gaps, hop single blocks and bars, dive through glass and climb the steps, and they can be pushed off, knocked off or zapped like you. Now and then, when no wall is close, a rival picks a fight with the nearest runner nobody else is after. It walks up and winds up (the arm pulls back) before it punches, or jumps and dives in for a Super Punch, and against another rival it lines up its punch to send it toward the nearest edge. Rivals fight each other more often than they go for you, and they go easier on you: they don't aim you at an edge, they only dive in for a Super Punch on you on Normal and harder (and rarely), and their punches fling you less far (half as far on Very easy, 70% on Normal, the full fling on Very hard). How often they fight depends on the difficulty. The **RIVALS** chip counts who is still in, and a line under it says who knocked out whom. The run is still yours: it ends only when you are out, and only your waves count. If a punch sends you off, the game-over screen says who threw it.

There is no online multiplayer. Every runner's punches are settled in one place, once per physics step, for all runners together. That is the point a networked version would run on its server. The numbers are constants in the script: `MOMENTUM` (how fast the hidden meter builds and drains), `PUNCH` and `SUPER_PUNCH` near the top (reach and hitbox size, timing, cooldown, knockback from a standstill and how much each bit of momentum adds, lift, time to get up), `FLING` (drag in the air and on landing, and the safe time after), `KNOCKDOWN` (getting up, how long a rival keeps you down, how hard a shove pushes), `HUG` (the grab's reach, how long it holds, how fast you walk carrying someone), `SPATULA` (its reach, width and height, the knock-down time, the cooldown and the flip that gets you up), `TACKLE` (the slide tackle's speed, slide time, reach, fling height and cooldown, and the dive tackle's dash: its length and speed), `TAUNT` (how much of a dive's speed a taunt leaves you, and how long the stick you were holding is ignored), `RESPAWN` (respawn mode's waits after a fall or a zap, the guard when you drop back in, and when rivals come back), `VAULT` (how high a taunt clears spikes and bars, and how fast it goes back over them), and `RIVAL_FIGHT_GAP`, `RIVAL_PICKS_YOU`, `RIVAL_DIVES_AT_YOU` and `RIVAL_HITS_YOU` beside the rivals' code (how often they fight, how often they pick you, how often they dive at you, and how hard they hit you).

## Emotes

Nine emotes, all original animations, in two groups. You take **four** of them into a run.

**Your four:** on the main menu open **CUSTOMISE** and pick the **EMOTES** tab. The four slots across the top are your emotes; the ones in them are marked 1–4 below. Click (or tap) a slot, then the emote you want in it: it goes in, and if it was already in another slot the two swap. Your runner shows it off on the podium. **RANDOM** picks four for you and **RESET** brings back the first four (Tackle, Hug, Laugh, Dance). Your four are saved.

**Their keys:** in a run `1`, `2`, `3` and `4` play emote 1 to 4. To change one, click the key under its slot and press the new one (**Esc** cancels, **Backspace** takes it off); they're also listed as Emote 1–4 under **Settings → CHANGE KEYS**. While you play, your four sit over the **PUNCH** chip at the bottom right with their keys, and you can click one when the cursor is free. On a touch screen the **EMOTE** button above **JUMP** opens a tray of your four: tap one (the tray puts itself away after a few seconds if you don't).

**Hostile** (aimed at whoever's closest):

- **Tackle:** a slide tackle. You drop onto one hip, lean right back and slide feet first along the floor, the leading leg out straight, one hand trailing and the other arm up, with dust flying. It really moves you: about 3.4 m the way you run (or where you look, standing still), faster if you were already running. You can't steer, jump or punch until you're back up a second later, and there's a short wait before the next one. Anyone your feet catch is flung about one block (1.86 m) up, tumbling, and lands a little further on; if that sends them off the arena, the knock-out is yours. Jump over a tackle to dodge it. While sliding you're as low as in a dive's belly-slide, and a tackle smashes breakable glass in its way, like a dive (the bottom block of a two-high stack).
  - **Dive tackle:** tackle during a dive (in the air, or the belly-slide after it) and the dive turns into the tackle with a **dash**: you shoot two blocks (3.72 m) straight on, feet first, in under a fifth of a second, from the air if need be, then slide on as usual. That's about 6.8 m in all. It goes the way you steer, or on the way the dive was going. Whoever it catches is flung exactly like a normal tackle.
- **Hug:** grab whoever's in front of you. Face them (the way you run, or where you look standing still) within about 2.3 m: you turn to them, wrap your arms round them, lift them off their feet and hold on for 1 second, with hearts. While you hold them you can walk about with them (a little slower than usual) and they can't move, only kick their legs; you can't jump. Carry them into a laser fence or off the end of the arena and the knock-out is yours. A punch lets go and lands on them straight away; being hit, a wall or dropping off something also makes you let go. You can even pick someone up who's lying knocked down. Nobody in front of you: a hug for yourself.
- **Spatula:** out comes a big kitchen spatula (red handle, slotted steel blade). You raise it high and back, step in and bring it down flat with a **WHAP**, then the blade wobbles. It turns to the nearest runner within 3 m (or where you look), and it reaches a little further and wider than a punch: about 2.6 m in front of you, against a punch's 2.1. Whoever it catches **drops flat where they stand**: no push back at all, just a little hop, then 2 seconds on the floor, where you can shove them like anyone knocked down. Knocked down yourself, the spatula is the one emote that works: it **flips you straight back onto your feet** (with the usual moment of guard) and swats in the same move. Mid-dive (in the air, or the belly-slide after it) it **stands you up** too, and **keeps all the dive's momentum**: upright, you glide on just as far as the dive would have carried you, land on your feet and run on. Steering or a press can't stop the swat before it comes down, and when it does it turns to whoever's nearest within 3 m, even if you've flown past them, reaching down below you from the air. One swat every 3 seconds. A taunt shrugs it off, and it doesn't go through walls.
- **Boxing:** fists up, a bounce on the toes with a weave, a left jab and a right jab (the arms shoot out, like a punch), then a crouch and a big uppercut with a hop and a **POW**. It squares up to a runner within reach, and they flinch back.

**Dances & taunts:** while one plays you're **shielded**. A soft cyan bubble shows round you, and punches (Super Punches too), tackles, hugs and boxing bounce off it with a **NOPE!**: nothing happens to you, and you hold your ground even when someone slides into you. Moving, jumping or punching ends the taunt and the shield with it. **Spikes and bars can't knock you away either:** one coming at you lifts you up its face and over it (your feet clear its top by about a block's height), and you come down behind it, still dancing. One you touch from the side or behind is only solid. A plain wall still pushes you along (and that ends the taunt), and crushers and lasers still get you. Rivals are shielded the same way while they show off, and they don't pick fights with anyone who's shielded.

**Taunting out of a dive:** a dance or taunt also works in the middle of a dive (in the air, or the belly-slide after it). The dive stops dead: you drop where you are with almost none of its speed, and the taunt plays, shield and all. The direction you were holding doesn't count for the first 0.45 s, so it doesn't end the taunt straight away. Let go and the taunt plays on; keep holding and you run on after that moment. (Hug and boxing can't be done mid-dive.)

- **Laugh:** thrown back laughing with the hands on the belly and the shoulders shaking, then doubled over, with HA HA floating up.
- **Dance:** four bouncy bars of swinging hips, arms swapping up and down and knees lifting in turn, with music notes.
- **Robot:** stiff moves that snap from pose to pose with a little shudder (one arm out, the other, both out to the sides, both up), then a power-down slump and a reboot, with bleeps and a BEEP and a BOOP.
- **Point:** the arm draws back and shoots out at the nearest runner (a question mark pops over them) or at the camera, the other hand on the hip and the head cocked, with a couple of jabs.
- **Cheer:** a crouch, a big jump with both arms up, two fist-pumping hops, and confetti.

The tackle, the hug and the spatula are the emotes that do something to people: boxing's flinch is only for show. Your **PUNCH** (`F`) still hits harder and farther.

Each emote moves the body's parts: arms, legs, hips, head, eyes and an opening mouth. They are keyframed with anticipation and follow-through and blended smoothly in and out of the normal pose. The runner turns to face the camera (three-quarters on) or whoever the emote is aimed at, and the camera comes in a little closer and lower while you emote; when it's aimed at someone (boxing or a point) it swings round to the side so you see both of you. Apart from the tackle and holding someone in a hug, nothing about where you are or which way you're going changes. You can only emote standing on something (out of a dive, only the tackle, the spatula and the dances and taunts; knocked down, only the spatula), and moving, jumping, punching, being hit, being pushed by a wall or leaving the ground ends one (it eases out in 0.2 s; a tackle only ends early if you leave the ground, get hit or slide into a wall, and a hug's hold when it lets go); a new one replaces the one playing. Rivals emote too: they flinch, now and then show off when no wall is coming, and laugh or cheer after knocking someone out or surviving a wave. They stop for it only while no wall is close.

New emotes go in `EMOTES` in the script: a list of joint channels with keyframes (and optional extra motion and timed effects), with a `group` (`hostile` or `fun`). Adding one to the list puts it under **CUSTOMISE → EMOTES**, ready to go in a slot.

## Changing the keys

**Settings → CHANGE KEYS** lists every keyboard control: run forward, back, left and right, jump (and dive), punch, pause and restart, Emote 1–4 (with the emote that's in each), and flying up and down while you build waves. Each one can have two keys. Click a key, then press the new one; **Esc** cancels and **Backspace** takes the key off. A key does one thing at a time: give it to a new action and it comes off the old one, and the screen says so. One key can still mean one thing in a run and another while building (Space jumps in a run and flies up in the builder). An action with no key is marked in red. **RESET KEYS** puts the defaults back.

Keys are kept by their place on the keyboard, not the letter printed on them, so they stay put on any layout; where the browser shares it, the screen shows your keyboard's own letters (Z for the W position on AZERTY). Every hint follows your keys: the menu line, How to Play, the PUNCH meter, the pause screen and the builder's help line. `Esc` always pauses and goes back, the mouse turns the camera, a left click (with the cursor hidden) also punches, and `1`–`5` pick blocks in the builder; those can't be changed. The keys are saved in `localStorage` under `blockdash.keys.v1`.

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
| `X` `Y` | Spikes, one (`X`) or two (`Y`) cubes high: dark cubes with spikes on every side but the bottom. You can't stand on them, and touching them knocks you backwards |
| `K` `G` | Breakable glass, one (`K`) or two (`G`) blocks stacked: solid like any block, but dive or slide-tackle into a block and it shatters. Each block breaks on its own |
| `B b` | Bar: a low striped bar lying across two lanes (`B` is its left half, `b` its right). Hop over it; touching it knocks you backwards |

How contact works:

- **Front of an incoming wall:** it pushes you along with it. You can slide sideways along it freely into a hole, or run away from it. You can still jump while it shoves you, to the full height: against a single-block wall you sail up and land on top of it.
- **Side of a block:** solid. You stop against it.
- **Back of a wall:** solid too. If you catch up with a wall that has already passed you, you stop against it and move along with it.
- **Breakable blocks:** solid like any block, so they push you when you run into them and you can stand on a one-high one. Dive into one, belly-slide into it after a dive, or slide-tackle through it (the TACKLE emote, or a dive tackle's dash), and it always shatters, however little of it you hit, and you carry straight on. One dive (or tackle) smashes one block per stack, the one you're mostly inside; the blocks above or below it stay where they are (floating, if the block under them broke), even if the same dive brushes them. So a low dive (jump, then dive on the way down) breaks the bottom block of a two-high stack and you go under the top one, while a dive from high up breaks the top one and leaves the bottom one standing. A new dive can smash the next block.
- **Spikes and bars:** solid, and they knock you backwards with a short tumble (no control for under half a second). While you dance or taunt they can't: they lift you over themselves instead (see Emotes). Coming at you, they throw you back toward the near edge; touch one from the side or from behind and you're thrown away from it. You can't stand on either. A bar is low (0.8 units), so a jump timed as it arrives, or a running jump, clears it. Get knocked off the edge and the run ends with **Knocked off the edge**.
- **Top of a block:** safe to stand on. A ridden block carries you toward the near edge, and you keep that momentum when you jump off. Every block is the same cube, and taller obstacles are whole cubes stacked on top of each other. Stacks can't be reached from the floor; climb onto them from a single block, or up the steps of a climb lane. While you climb you ride along with the wall, so climbing doesn't eat into the time before the next wall.
- **Late jump:** run or slide off something without jumping (a block's edge, the arena's edge, or a block that drops away under you) and your next press is still a **jump**, not a dive, however late, as long as you're not already more than 0.6 below the floor. A press that's too low to jump does nothing in the air; it jumps if you land within a moment.
- **Dive:** press jump again in the air, after a jump. You lunge forward in your steering direction (or the way you face) with a small hop and a low profile, covering about 6.4 units from the top of a jump, then do a short belly slide.

The run only ends if you **fall off the arena** (off the front or back edge: pushed off, ridden off or walked off) or **touch a laser fence** on the sides. Falling off means a long drop before the run is over, and walls teeter on the near edge for a moment before they fall, giving a rider time to jump off. A teetering wall stays solid until it tips into the void. The floor is a little slippery: you reach full speed in about 0.13 s and turn quickly, but glide a short way (under two units) when you let go. A wall hands you its momentum when it shoves you, and you bounce lightly off block sides. There's no gate: walls rise out of the platform right at the far edge.

The six patterns from the brief (Basic Corridor, Alternating Gaps, Double Corridors, Jump Challenge, Narrow Zigzag, Moving Obstacles) are included verbatim. Six wall waves (Wall Rush, Hop or Hole, Slider, Twin Walls, Crusher Wall, Last Gap) are picked more often than the rest. Six more grid patterns also unlock as the wave count grows: Hurdle Run, Staircase, Hop Scotch, Split Decision, Crusher Alley and The Gauntlet. Four climb-wall patterns (Step Up, Climb Wall, Summit and Sky Ladder) appear only on Normal and harder. Four more bring in spikes and bars: Bar Hop, Spike Fence, Bar Run and Spike Slalom. Glass Garden and Smash Through have breakable blocks (Smash Through has walls you can only get through by diving), and Spike Towers has two-high spikes.

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

Pick an outfit under **CUSTOMISE** on the main menu (the **SKINS** tab; your emotes are on the **EMOTES** tab, see above). There are 30 original outfits: Classic, Ninja, Astronaut, Robot, Pirate, Chef, Royal, Wizard, Kitty, Bunny, Teddy, Dino, Viking, Cowboy, Knight, Swimmer, Propeller, Party, Super, Alien, Angel, Devil, Froggy, Unicorn, Shark, Snowy, Firefighter, Detective, Jetpack and Sporty. Each is a head, face and back item on the runner, built from simple shapes. Every outfit has six colours you can change: skin, top, bottom, hat, shoes and detail. **RANDOM** rolls new colours and **RESET** goes back to the outfit's own.

The runner shows off the outfit on a podium beside the arena; drag beside the panel to turn it. Some items move: capes and tails sway, propellers spin, wings flap and the jetpack fires while you're in the air.

## Block designer

Paint your own blocks under **BLOCKS** on the main menu. You get a loadout of 20 designs, each a 16×16 pixel block face shown on every side of the cube. The loadout starts with 20 starter designs you can paint over: Tile, Bricks, Crate, Checker, Hazard, Smiley, Heart, Star, Gem, Circuit, Dots, Ice, Lava, Stone, Gift, Target, Window, Neon, Cookie and Plain.

- **DRAW** paints cells (drag to paint a line), **FILL** floods an area, and **PICK** takes a colour from the design. **MIRROR** paints both halves at once, and **UNDO** (or Ctrl+Z) steps back. **CLEAR** paints the whole face in the current colour.
- Choose from 24 colours, or any colour with the rainbow swatch. **Template…** loads one of the starter designs into the slot, and **COPY** / **PASTE** copy a design from one slot to another.
- **In game** puts a design in the loadout the walls use. Each wave uses the next design that is in game, in slot order. With none in game, the walls use the classic look.
- **Wave colour** tints the design with each wave's colour; paint it in light tones for that. Without it the design keeps its own colours. Climb lanes are drawn a little brighter either way, and crushers keep their own look.
- The design shows live on a little stack of blocks on the podium beside the panel; drag there to turn it.

## Wave layouts

Build your own waves under **WAVES** on the main menu. The panel holds your 30 layout slots; press **BUILD** (or click the arena) to fly in and build. The background walls pause while you build, your runner waits just off the near edge, and glowing arrows past the far edge show where the walls roll in from.

A layout is a 3D grid on the whole map: 12 lanes across, 20 squares from the near edge to the far one, and up to 6 blocks high. You can stack blocks on top of each other, build out sideways from a block, and leave gaps underneath: towers, stairs, doorways and tunnels (a runner fits under a block that floats one block up). The wave arrives exactly as you built it, as one formation with the rows one square apart, so you set the spacing yourself: leave empty rows between walls to give yourself time. The row nearest your runner is the front of the wave and reaches you first. Empty rows before the first block and after the last one are left out, and the wave still starts at least 7 seconds after the last wall of the wave before it.

**Building**

| | Desktop | Touch |
|---|---|---|
| Fly | `W A S D` or arrow keys, `Space` up, `Shift` down (`E` and `Q` work too) | The pad on the left; **UP** and **DOWN** |
| Look | Move the mouse (the cursor is hidden while you build) | Drag on the view |
| Place a block | Left click: it goes against the face you point at, or on the floor | Tap where it should go |
| Remove a block | Right click | Turn on **REMOVE**, then tap |
| Pick the kind | `1`–`5` or the mouse wheel, or click the hotbar | Tap the hotbar |
| Back to the panel | `Esc` | **MENU** |

A crosshair shows where you aim, the block you point at gets a white outline, and a see-through block shows where the next one will go (red when it can't go there). If the browser won't hide the cursor, you look by dragging and place by clicking, the same as on a touch screen.

The hotbar has five kinds of block: **BLOCK** (an ordinary block in the wave's colour), **SPIKES** (knocks you back), **GLASS** (breakable: dive or tackle through it), **BAR** (a low striped bar segment; bars side by side join into one long bar) and **CRUSHER** (rises and slams down). A crusher only goes on the floor, with two clear blocks of room above it, and nothing can be stacked on a crusher or a bar.

- **MIRROR** builds on both sides of the arena at once, **UNDO** (or Ctrl+Z) takes back the last change, and **CLEAR** empties the slot. **Start from…** copies a built-in pattern into the slot, as blocks you can then change.
- Give each layout a name; it shows in the wave banner when it comes up.
- Nothing is checked or blocked. Any layout with at least one block is ready to play, and the status line counts the blocks. The laser fences stand right beside the outer lanes, so a row built all the way across is a wall from fence to fence with no way around it.
- The 8 pips under the wave counter fill up as the rows of your wave go past.
- **In game** mixes the layout in with the built-in waves. **Only my layouts** makes every wave one of yours, in slot order. The difficulty slider still sets the speed and reaction time.
- **TRY IT** starts a practice run with only that layout. Practice runs don't count for your personal best, and when the run ends **BACK TO EDITOR** takes you straight back.
- Layouts made with the earlier flat grid editor are turned into blocks when they load: each square becomes a stack of the same height and kind, and a climb lane becomes a 3-high stack with stairs (2 high, then 1) on the two squares in front of it.

## Settings and saved data

The Settings screen covers graphics quality (Low, Medium, High), field of view (70° by default), camera X and Y offset, your keyboard keys (**CHANGE KEYS**), mouse and camera sensitivity, joystick sensitivity and size (it scales the **JUMP** and **PUNCH** buttons too), the number of rival runners, volume, sound effects, music and vibration. Settings (including the difficulty and the game mode) are stored in `localStorage` under `blockdash.settings.v1`. The personal best is kept per difficulty: `blockdash.bestWave` for Normal and `blockdash.bestWave.1`, `.2`, `.4` and `.5` for the other levels. Your keys are stored under `blockdash.keys.v1`, your name in rooms under `blockdash.name.v1`, and the rooms PIN each server accepted from this device under `blockdash.pins.v1`. The chosen outfit and your colours are stored under `blockdash.skin.v1`, your 20 block designs under `blockdash.blocks.v1`, and your 30 wave layouts under `blockdash.layouts.v1`.

## Performance

What each graphics quality (Settings → Graphics) changes:

| | Low | Medium | High |
|---|---|---|---|
| Resolution (device pixels per CSS pixel, at most) | 1 | 1.5 | 2 |
| Antialiasing (MSAA) | off | on, except on high-density (2×+) screens | on, except on high-density (2×+) screens |
| Shadows | off | 1024 × 1024 | 2048 × 2048 |
| Materials | plain diffuse (Lambert) | plain diffuse (Lambert) | physically based (Standard) |
| Frosted-glass blur behind the menus | off | off | on |
| Particles / floating decor / dust / stars | 160 / 16 / 60 / 300 | 300 / 30 / 140 / 550 | 420 / 46 / 240 / 850 |
| On a 120 Hz (or faster) screen | 60 frames a second | 60 frames a second | every refresh |

On every quality:

- **Fewer draws.** Parts of a runner that never move apart are one mesh: the torso with its stripe and shorts, and each leg with its shoe and sole, coloured per vertex. The eyes, cheeks and every skin item are merged by material. A runner is now about 16 draws instead of 27: with three rivals in view the main pass draws 106 meshes, down from 147.
- **A cheaper shadow pass.** Only the big parts of a runner cast a shadow (torso, head, legs and sleeves). In the same moment the shadow pass draws 27 meshes, down from 105.
- **No stalls mid-run.** Every shader is compiled while the game loads, and the rival runners and your block designs are built before the first run.
- **A paused game rests.** The arena is drawn once when you pause, then not again until you resume, resize the window or change a setting.
- **Less page work.** Hidden screens pause their looping animations; before, the PLAY button's shine forced a layout every frame of every run. The punch cooldown bar now restyles only itself, not the whole page. The small HUD chips have no blur.
- **Adaptive resolution.** If a run averages more than 24 ms a frame for 3 seconds, the resolution drops a step (down to 60%). It comes back up when frames are fast again.

## Debugging

Add `?debug=1` to the URL to expose `window.BlockDash` (game state, world, player, rivals, the punch settings and the pattern solver, and in a room `net` and `ghosts`) in the browser console.

How a room works, for anyone changing it (section 17b of `index.html`, and `server.js`):

- `server.js` is plain Node: an HTTP server for the page, `GET /api/status` and `POST /api/power` (`{ on, pin }`), and a small WebSocket server at `/ws` for JSON messages. It keeps the rooms and relays messages between the players in one; it never runs the game itself.
- A round's walls come from `world.seed`: every wave draws from its own seeded random stream (`seededRandom`), and in a room the walls speed up as each wave passes the start line (`world.syncSpeed`), not as you pass it. `netPlay` runs the round in fixed steps (`NET.step`, 1/120 s) up to the round's clock: GO is a moment on the server's clock (`start.at`), and each device knows how far its clock is from the server's (a few `ping`s; the quickest round trip wins).
- Your runner goes out as a `snap` (`packSnap`) every 50 ms. Others are `ghosts`: runners that never step themselves, moved from their last snap on at its speed and eased onto it. In `combat`, ghosts never attack (their own device does that), and whatever you land on a ghost is sent to its player as an `ev` (`hit`, `tackle`, `swat`, `blocked`, `flinch`, `grab`/`release`/`free`, `shove`); `net.onEvent` applies it to you. A smashed glass block is an `ev` to everyone (`glass`).
