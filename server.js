#!/usr/bin/env node
// Block Dash local server: serves the game to every device on your Wi-Fi and runs the rooms you play in together.
//
//   node server.js            (Node 18 or newer; nothing to install)
//   BlockDash.exe             (Windows: the same server with the game inside, see tools/build-exe.mjs)
//
// Then open the address it prints on every device that wants to play (phones and tablets too). Everyone on the
// same Wi-Fi can host a room or join one from the game's ROOMS screen. BlockDash.exe opens the game on its own
// computer by itself (node server.js --open does too); --no-open stops that.
//
// The rooms can be switched off and on from any of those devices (ROOMS → the server bar). From this computer that
// needs nothing; from another device it needs the PIN printed below (it changes every start unless you set one).
// Switched off, nobody can join and every room closes, but the page still loads, so you can switch it back on.
//
// Options (environment variables): PORT (8080; if it's taken, the next free one), BLOCKDASH_PIN (four digits,
// instead of a random one), BLOCKDASH_START_OFF=1 (start with the rooms off), BLOCKDASH_TRUST_LOCAL=0 (ask for the
// PIN on this computer too).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Packed into BlockDash.exe (a Node.js single executable application), the game and Three.js are inside it.
let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
const embedded = (name) => { try { return sea ? Buffer.from(sea.getAsset(name)) : null; } catch { return null; } };
const PAGE = embedded('index.html');                    // (null: read index.html next to this file, fresh every time)
const THREE_JS = embedded('three.module.min.js') || (() => {   // a copy of Three.js to serve: no internet needed
  try { return fs.readFileSync(path.join(__dirname, 'vendor', 'three.module.min.js')); } catch { return null; }
})();
const THREE_PATH = '/vendor/three.module.min.js';

const PORT = +process.env.PORT || 8080;
let port = PORT;                                        // (the one it got: the next one up if PORT was taken)
const PIN = /^\d{4,8}$/.test(process.env.BLOCKDASH_PIN || '') ? process.env.BLOCKDASH_PIN : String(crypto.randomInt(1000, 10000));
const TRUST_LOCAL = process.env.BLOCKDASH_TRUST_LOCAL !== '0';
const OPEN = process.argv.includes('--open') || (!!sea && !process.argv.includes('--no-open'));
const GAME = path.join(__dirname, 'index.html');
const MAX_PLAYERS = 8;
const MODES = ['regular', 'respawn', 'legendary', 'legendary-respawn'];   // (Legendary Block Dash: the red floor)
const isRespawn = (mode) => mode === 'respawn' || mode === 'legendary-respawn';
const START_DELAY = 3200;                               // ms from START to GO (everyone's countdown ends together)
const LAST_ONE_WAIT = 2500;                             // ms the last runner standing gets to celebrate before the results
let roomsOn = process.env.BLOCKDASH_START_OFF !== '1';

// ---------------------------------------------------------------------------------------------------------------
// Addresses this computer has on the local network (where the others open the game)
// ---------------------------------------------------------------------------------------------------------------
// (Wi-Fi and wired ones first: home networks are 192.168.x.x or 10.x.x.x; virtual machines' and WSL's last.)
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vethernet|virtualbox|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn/i.test(name);
      const home = /^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      out.push({ address: a.address, rank: (virtual ? 10 : 0) + home });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((a) => a.address);
}
const isLocal = (req) => {
  const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1';
};

// ---------------------------------------------------------------------------------------------------------------
// HTTP: the game page, the server's status, and its on/off switch
// ---------------------------------------------------------------------------------------------------------------
function status(req) {
  let players = 0;
  for (const c of clients.values()) if (c.open) players++;
  const local = isLocal(req);
  return {
    server: 'blockdash', on: roomsOn, rooms: rooms.size, players, port,
    addresses: lanAddresses().map((a) => `http://${a}:${port}`),
    local, pin: local ? PIN : undefined,                // (only this computer is told the PIN)
  };
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/status' && req.method === 'GET') return sendJson(res, 200, status(req));
  if (url.pathname === '/api/power' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      let msg = {};
      try { msg = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad request' }); }
      if (!(TRUST_LOCAL && isLocal(req)) && String(msg.pin || '') !== PIN) return sendJson(res, 403, { error: 'wrong PIN' });
      setRoomsOn(!!msg.on);
      sendJson(res, 200, status(req));
    });
    return;
  }
  if ((url.pathname === '/' || url.pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
    const serve = (data) => {
      // (with a copy of Three.js here, the page is told to load it from here first: no internet needed to play)
      const html = THREE_JS ? data.toString('utf8').replace('<head>', `<head>\n<meta name="blockdash-three" content="${THREE_PATH}">`) : data;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : html);
    };
    if (PAGE) { serve(PAGE); return; }
    fs.readFile(GAME, (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found next to server.js'); return; }
      serve(data);
    });
    return;
  }
  if (url.pathname === THREE_PATH && THREE_JS && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    res.end(req.method === 'HEAD' ? undefined : THREE_JS);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------------------------------------------------------------------------------------------------------
// WebSocket (RFC 6455), just what the game needs: text messages, ping/pong and close
// ---------------------------------------------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024;
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  return Buffer.concat([head, payload]);
}
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  if (!roomsOn) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const c = addClient(socket);
  let buf = Buffer.alloc(0), parts = [];
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; if (buf.readUInt32BE(2)) return dropClient(c); len = buf.readUInt32BE(6); off = 10; }
      if (len > MAX_MESSAGE) return dropClient(c);
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 0x8) { try { socket.write(frame(0x8, Buffer.alloc(0))); } catch { /* gone */ } return dropClient(c); }
      if (op === 0x9) { try { socket.write(frame(0xA, payload)); } catch { /* gone */ } continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x0) {
        parts.push(payload);
        if (!fin) { if (parts.reduce((s, p) => s + p.length, 0) > MAX_MESSAGE) return dropClient(c); continue; }
        const text = Buffer.concat(parts).toString('utf8');
        parts = [];
        let msg;
        try { msg = JSON.parse(text); } catch { continue; }
        if (msg && typeof msg === 'object') onMessage(c, msg);
      }
    }
  });
  socket.on('close', () => dropClient(c));
  socket.on('error', () => dropClient(c));
});

// ---------------------------------------------------------------------------------------------------------------
// Players and rooms
// ---------------------------------------------------------------------------------------------------------------
const clients = new Map();                              // id → { id, socket, open, name, skin, room }
const rooms = new Map();                                // id → { id, name, host, members: [ids], state, settings, seed, outs, last, stats }
let nextClient = 1, nextRoom = 1;
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const log = (text) => console.log(`  ${new Date().toTimeString().slice(0, 5)}  ${text}`);   // what's going on, one line each

function addClient(socket) {
  const c = { id: nextClient++, socket, open: true, name: `Player ${nextClient - 1}`, skin: null, room: null };
  clients.set(c.id, c);
  return c;
}
function send(c, msg) {
  if (!c || !c.open) return;
  try { c.socket.write(frame(0x1, Buffer.from(JSON.stringify(msg)))); } catch { dropClient(c); }
}
function dropClient(c) {
  if (!c || !c.open) return;
  c.open = false;
  leaveRoom(c);
  clients.delete(c.id);
  try { c.socket.destroy(); } catch { /* gone */ }
  broadcastLists();
}
function roomView(r) {
  return {
    id: r.id, name: r.name, host: r.host, state: r.state, settings: r.settings,
    players: r.members.map((id) => { const c = clients.get(id); return { id, name: c ? c.name : '?', skin: c ? c.skin : null }; }),
  };
}
const roomList = () => [...rooms.values()].map((r) => ({ id: r.id, name: r.name, players: r.members.length, max: MAX_PLAYERS, playing: r.state === 'playing' }));
function broadcastLists() {                             // (everyone not in a room sees the room list change)
  const list = roomList();
  for (const c of clients.values()) if (!c.room) send(c, { t: 'rooms', rooms: list });
}
function toRoom(r, msg, except) { for (const id of r.members) if (id !== except) send(clients.get(id), msg); }
function roomChanged(r) { toRoom(r, { t: 'room', room: roomView(r) }); broadcastLists(); }

function leaveRoom(c) {
  const r = c.room && rooms.get(c.room);
  c.room = null;
  if (!r) return;
  r.members = r.members.filter((id) => id !== c.id);
  log(`${c.name} left "${r.name}"`);
  if (!r.members.length) { if (r.lastTimer) clearTimeout(r.lastTimer); rooms.delete(r.id); log(`"${r.name}" closed`); return; }
  if (r.host === c.id) r.host = r.members[0];         // the next one in becomes the host
  toRoom(r, { t: 'left', id: c.id });
  if (r.state === 'playing') {
    if (r.winner === c.id) r.winner = null;
    if (r.lastTimer && !r.members.some((id) => !r.outs.has(id))) endRound(r);
    else checkRoundOver(r);
  }
  roomChanged(r);
}
// Regular rounds end when everybody is out, or soon after only one runner is left standing (if more than one
// started): that one wins. Respawn rounds go on until the host ends them.
function checkRoundOver(r) {
  if (r.state !== 'playing' || isRespawn(r.settings.mode)) return;
  const left = r.members.filter((id) => !r.outs.has(id));
  if (!left.length) { endRound(r); return; }
  if (left.length === 1 && r.startedWith > 1 && !r.lastTimer) {
    r.winner = left[0];
    toRoom(r, { t: 'last', id: left[0] });
    r.lastTimer = setTimeout(() => { r.lastTimer = null; endRound(r); }, LAST_ONE_WAIT);
  }
}
const statOf = (r, id) => { if (!r.stats.has(id)) r.stats.set(id, { falls: 0, kos: 0 }); return r.stats.get(id); };
function credit(r, c, by) {                             // a knock-out for whoever put c out (not themselves)
  by = +by || 0;
  if (by && by !== c.id && r.members.includes(by)) statOf(r, by).kos++;
  return by && by !== c.id ? by : null;
}
function endRound(r) {
  if (r.state !== 'playing') return;
  r.state = 'lobby';
  if (r.lastTimer) { clearTimeout(r.lastTimer); r.lastTimer = null; }
  const results = r.members.map((id) => {
    const c = clients.get(id), o = r.outs.get(id) || r.last.get(id) || {}, st = statOf(r, id);
    return { id, name: c ? c.name : '?', waves: o.waves || 0, time: o.time || 0, falls: Math.max(o.falls || 0, st.falls), kos: st.kos,
      out: r.outs.has(id), winner: r.winner === id };
  });
  if (isRespawn(r.settings.mode)) results.sort((a, b) => a.falls - b.falls || b.kos - a.kos || b.waves - a.waves);
  else results.sort((a, b) => (a.out - b.out) || b.time - a.time || b.waves - a.waves || b.kos - a.kos);   // (still in first, then whoever lasted longest)
  toRoom(r, { t: 'end', results, mode: r.settings.mode });
  log(`"${r.name}": round over${results.length ? `, ${results[0].name} first` : ''}`);
  roomChanged(r);
}

function onMessage(c, m) {
  const r = c.room && rooms.get(c.room);
  switch (m.t) {
    case 'hello':
    case 'profile':
      c.name = clean(m.name, 14) || c.name;
      c.skin = m.skin && typeof m.skin === 'object' ? { id: clean(m.skin.id, 20), colors: m.skin.colors || {} } : c.skin;
      if (m.t === 'hello') send(c, { t: 'welcome', id: c.id, rooms: roomList() });
      else if (r) roomChanged(r);
      break;
    case 'list':
      send(c, { t: 'rooms', rooms: roomList() });
      break;
    case 'ping':                                         // clock sync: the game works out how far its clock is from this one
      send(c, { t: 'pong', c: m.c, s: Date.now() });
      break;
    case 'host': {
      leaveRoom(c);
      const room = { id: nextRoom++, name: clean(m.name, 24) || `${c.name}'s room`, host: c.id, members: [c.id], state: 'lobby',
        settings: { difficulty: 3, mode: 'regular' }, seed: 0, outs: new Map(), last: new Map(), stats: new Map(),
        startedWith: 0, winner: null, lastTimer: null };
      if (m.settings) Object.assign(room.settings, sanitizeSettings(m.settings));
      rooms.set(room.id, room);
      c.room = room.id;
      log(`${c.name} opened "${room.name}"`);
      roomChanged(room);
      break;
    }
    case 'join': {
      const room = rooms.get(+m.room);
      if (!room) return send(c, { t: 'error', msg: 'That room is gone.' });
      if (room.state !== 'lobby') return send(c, { t: 'error', msg: 'That room is playing. Wait for the round to end.' });
      if (room.members.length >= MAX_PLAYERS) return send(c, { t: 'error', msg: 'That room is full.' });
      if (c.room !== room.id) { leaveRoom(c); room.members.push(c.id); c.room = room.id; log(`${c.name} joined "${room.name}"`); }
      roomChanged(room);
      break;
    }
    case 'leave':
      leaveRoom(c);
      send(c, { t: 'rooms', rooms: roomList() });
      break;
    case 'settings':
      if (r && r.host === c.id && r.state === 'lobby') { Object.assign(r.settings, sanitizeSettings(m)); roomChanged(r); }
      break;
    case 'start':
      if (r && r.host === c.id && r.state === 'lobby') {
        r.state = 'playing';
        r.seed = crypto.randomInt(1, 2 ** 31);
        r.outs = new Map(); r.last = new Map(); r.stats = new Map();
        r.startedWith = r.members.length; r.winner = null;
        // everyone gets the same walls (the seed) and the same moment to go (`at`, on this server's clock)
        toRoom(r, { t: 'start', seed: r.seed, at: Date.now() + START_DELAY, settings: r.settings, players: roomView(r).players });
        log(`"${r.name}": round started, ${r.members.length} player${r.members.length === 1 ? '' : 's'} (${r.settings.mode})`);
        roomChanged(r);
      }
      break;
    case 'snap':                                         // where you are and what you're doing, to everyone else in the room
      if (r && r.state === 'playing') {
        if (m.s) r.last.set(c.id, { waves: +m.s.w || 0, time: +m.s.tm || 0, falls: +m.s.f || 0 });
        toRoom(r, { t: 'snap', id: c.id, d: m.d, s: m.s }, c.id);
      }
      break;
    case 'ev':                                           // something you did to someone (or to the world)
      if (r) {
        const msg = { t: 'ev', from: c.id, e: m.e };
        if (m.to) { if (r.members.includes(+m.to)) send(clients.get(+m.to), msg); }
        else toRoom(r, msg, c.id);
      }
      break;
    case 'out':                                          // you're out of the round (one fall and you're out)
      if (r && r.state === 'playing' && !r.outs.has(c.id)) {
        r.outs.set(c.id, { waves: +m.waves || 0, time: +m.time || 0, falls: +m.falls || 0 });
        toRoom(r, { t: 'out', id: c.id, by: credit(r, c, m.by), cause: clean(m.cause, 60) }, c.id);
        checkRoundOver(r);
      }
      break;
    case 'fall':                                         // respawn mode: you fell (or got zapped) and drop back in
      if (r && r.state === 'playing') {
        statOf(r, c.id).falls++;
        toRoom(r, { t: 'fall', id: c.id, by: credit(r, c, m.by), cause: clean(m.cause, 60) }, c.id);
      }
      break;
    case 'end':
      if (r && r.host === c.id) endRound(r);
      break;
    default: break;
  }
}
function sanitizeSettings(s) {
  const out = {};
  if (Number.isInteger(+s.difficulty) && +s.difficulty >= 1 && +s.difficulty <= 5) out.difficulty = +s.difficulty;
  if (MODES.includes(s.mode)) out.mode = s.mode;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// On and off
// ---------------------------------------------------------------------------------------------------------------
function setRoomsOn(v) {
  if (roomsOn === v) return;
  roomsOn = v;
  if (!v) {                                             // everyone's told, and every room closes
    for (const c of [...clients.values()]) { send(c, { t: 'off' }); dropClient(c); }
    for (const r of rooms.values()) if (r.lastTimer) clearTimeout(r.lastTimer);
    rooms.clear();
  }
  log(`Rooms are ${v ? 'ON' : 'OFF'}.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Starting up: the first free port from PORT on (or, if Block Dash is already running here, open that one instead),
// then the addresses, the PIN, and the game opened on this computer (BlockDash.exe, or --open)
// ---------------------------------------------------------------------------------------------------------------
function openGame(url) {
  const quiet = { detached: true, stdio: 'ignore' };
  try {
    if (process.platform === 'win32') {                 // Edge as an app window (a window of its own, like a game), else the browser
      const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
        .map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((f) => fs.existsSync(f));
      const child = edge ? spawn(edge, [`--app=${url}`, '--window-size=1280,760'], quiet) : spawn('cmd', ['/c', 'start', '', url], { ...quiet, windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } else {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], quiet);
      child.on('error', () => {});
      child.unref();
    }
  } catch { /* (the address is printed: open it by hand) */ }
}
function alreadyRunning(p) {                            // is that port Block Dash, already running on this computer?
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/status', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body).server === 'blockdash'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function fatal(text) {                                  // (BlockDash.exe: the window would close at once, so wait for Enter)
  console.error(`\n  ${text}\n`);
  if (sea && process.stdin.isTTY) {
    console.error('  Press Enter to close this window.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else process.exit(1);
}
function started() {
  const addrs = lanAddresses(), here = `http://localhost:${port}`;
  console.log('\n  BLOCK DASH server');
  console.log(`  On this computer:   ${here}${OPEN ? '   (opening it now)' : ''}`);
  for (const a of addrs) console.log(`  On your Wi-Fi:      http://${a}:${port}`);
  if (!addrs.length) console.log('  (No network found: connect this computer to your Wi-Fi to play with others.)');
  if (port !== PORT) console.log(`  (Port ${PORT} was taken, so it's ${port}.)`);
  console.log(`  PIN to switch the rooms off and on from another device: ${PIN}`);
  console.log(`  Rooms are ${roomsOn ? 'ON' : 'OFF'}. ${sea ? 'Close this window' : 'Press Ctrl+C'} to stop the server.`);
  if (process.platform === 'win32') console.log('  If Windows asks, allow it on private networks, so the others on your Wi-Fi can join.');
  console.log('');
  if (OPEN) openGame(here);
}
function listen(tries = 0) {
  const onListening = () => { server.off('error', onError); server.on('error', (e) => console.error(e)); started(); };
  const onError = async (err) => {
    server.off('listening', onListening);              // (this try's: a later one that works says it's started)
    if (err.code !== 'EADDRINUSE') { fatal(`The server could not start: ${err.message}`); return; }
    if (await alreadyRunning(port)) {                   // (opened twice: the one that's running is the one to play on)
      console.log(`\n  Block Dash is already running on this computer: http://localhost:${port}\n`);
      if (OPEN) openGame(`http://localhost:${port}`);
      setTimeout(() => process.exit(0), 2500);
      return;
    }
    if (tries >= 20) { fatal(`Ports ${PORT} to ${port} are all taken. Choose another: set PORT=9000 and start it again.`); return; }
    port++;
    listen(tries + 1);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '0.0.0.0');
}
if (sea) {
  try { process.title = 'Block Dash server'; } catch { /* (the window's title) */ }
  process.on('uncaughtException', (e) => fatal(`Something went wrong: ${e && e.stack ? e.stack : e}`));
}
listen();
