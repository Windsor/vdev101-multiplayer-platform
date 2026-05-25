/**
 * Multiplayer game server.
 *
 * Architecture:
 *   - Express serves the static client
 *   - WebSocket server handles real-time messaging
 *   - Rooms identified by 4-character codes; in-memory storage
 *   - Server is authoritative: holds state, runs game logic, computes
 *     a per-player "view" (with private info filtered) and broadcasts
 *     it to each connected player on every state change
 *   - Clients are dumb renderers: they receive a list of view sections
 *     describing what to show, and send back actions
 */

const path = require('path');
const http = require('http');
const os = require('os');
const { randomUUID } = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const games = require('./games/registry');

const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = 60_000; // delete a room this long after the last connection drops

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    games: games.list().map((g) => g.id),
  });
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

/** @type {Map<string, Room>} */
const rooms = new Map();

// ---------- Helpers ----------
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function gameInfo(g) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
    configSchema: g.configSchema || [],
  };
}

function publicPlayer(p, hostId) {
  return {
    id: p.id,
    name: p.name,
    isHost: p.id === hostId,
    connected: !!p.ws,
  };
}

function buildCtx(room, player) {
  return {
    state: room.state,
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    me: {
      id: player.id,
      name: player.name,
      isHost: player.id === room.hostId,
    },
    config: room.config,
    phaseId: room.phaseId,
    goTo: (id) => {
      room.phaseId = id;
    },
    shuffle,
    randomFrom,
  };
}

function buildView(room, player) {
  const me = {
    id: player.id,
    name: player.name,
    isHost: player.id === room.hostId,
  };
  const base = {
    code: room.code,
    me,
    players: room.players.map((p) => publicPlayer(p, room.hostId)),
    game: gameInfo(room.game),
  };
  if (room.status === 'lobby') {
    return {
      ...base,
      screen: 'lobby',
      config: room.config,
      canStart: me.isHost && room.players.length >= room.game.minPlayers,
    };
  }
  if (room.status === 'playing') {
    const phase = room.game.phases[room.phaseId];
    const ctx = buildCtx(room, player);
    return {
      ...base,
      screen: 'playing',
      phaseId: room.phaseId,
      sections: phase.getView(ctx),
    };
  }
  return { ...base, screen: 'lobby' };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.ws) send(p.ws, { type: 'view', view: buildView(room, p) });
  }
}

function sendHome(ws) {
  send(ws, {
    type: 'view',
    view: {
      screen: 'home',
      games: games.list().map(gameInfo),
    },
  });
}

// ---------- Connection lifecycle ----------
wss.on('connection', (ws) => {
  ws.player = null;
  ws.roomCode = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    handle(ws, msg);
  });

  ws.on('close', () => {
    if (!ws.roomCode || !ws.player) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const p = room.players.find((x) => x.id === ws.player.id);
    if (p) p.ws = null;

    // If everyone is gone, schedule room deletion. If host left, transfer host.
    const someoneConnected = room.players.some((x) => x.ws);
    if (!someoneConnected) {
      setTimeout(() => {
        const r = rooms.get(room.code);
        if (r && !r.players.some((x) => x.ws)) {
          rooms.delete(room.code);
        }
      }, ROOM_TTL_MS);
    } else {
      const host = room.players.find((x) => x.id === room.hostId);
      if (!host || !host.ws) {
        const newHost = room.players.find((x) => x.ws);
        if (newHost) room.hostId = newHost.id;
      }
      broadcast(room);
    }
  });

  sendHome(ws);
});

// ---------- Message router ----------
function handle(ws, msg) {
  switch (msg.type) {
    case 'create':      return handleCreate(ws, msg);
    case 'join':        return handleJoin(ws, msg);
    case 'rejoin':      return handleRejoin(ws, msg);
    case 'set-config':  return handleSetConfig(ws, msg);
    case 'start':       return handleStart(ws);
    case 'action':      return handleAction(ws, msg);
    case 'leave':       return handleLeave(ws);
    case 'home':        return sendHome(ws);
    default:            return send(ws, { type: 'error', message: `Unknown: ${msg.type}` });
  }
}

function cleanName(raw) {
  return String(raw || '').trim().slice(0, 20);
}

function handleCreate(ws, msg) {
  const game = games.byId(msg.gameId);
  if (!game) return send(ws, { type: 'error', message: 'Unknown game' });
  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', message: 'Name required' });

  const code = makeCode();
  const playerId = randomUUID();
  const player = { id: playerId, name, ws };
  const config = (game.configSchema || []).reduce((acc, f) => {
    acc[f.key] = f.default;
    return acc;
  }, {});
  const room = {
    code,
    hostId: playerId,
    game,
    config,
    status: 'lobby',
    players: [player],
    state: {},
    phaseId: null,
  };
  rooms.set(code, room);

  ws.player = player;
  ws.roomCode = code;
  send(ws, { type: 'identity', playerId, code });
  send(ws, { type: 'view', view: buildView(room, player) });
}

function handleJoin(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return send(ws, { type: 'error', message: 'Room not found' });
  if (room.status !== 'lobby') return send(ws, { type: 'error', message: 'Game already started' });
  if (room.players.length >= room.game.maxPlayers) return send(ws, { type: 'error', message: 'Room is full' });

  const name = cleanName(msg.name);
  if (!name) return send(ws, { type: 'error', message: 'Name required' });
  if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return send(ws, { type: 'error', message: 'Name already taken' });
  }

  const playerId = randomUUID();
  const player = { id: playerId, name, ws };
  room.players.push(player);

  ws.player = player;
  ws.roomCode = code;
  send(ws, { type: 'identity', playerId, code });
  broadcast(room);
}

function handleRejoin(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return sendHome(ws);
  const player = room.players.find((p) => p.id === msg.playerId);
  if (!player) return sendHome(ws);

  player.ws = ws;
  ws.player = player;
  ws.roomCode = code;
  send(ws, { type: 'identity', playerId: player.id, code });
  broadcast(room);
}

function handleSetConfig(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !ws.player) return;
  if (ws.player.id !== room.hostId) return;
  if (room.status !== 'lobby') return;
  const schema = (room.game.configSchema || []).find((f) => f.key === msg.key);
  if (!schema) return;
  room.config[msg.key] = msg.value;
  broadcast(room);
}

function handleStart(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room || !ws.player) return;
  if (ws.player.id !== room.hostId) return;
  if (room.status !== 'lobby') return;
  if (room.players.length < room.game.minPlayers) return;

  const ctx = {
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    config: room.config,
    shuffle,
    randomFrom,
  };
  room.state = room.game.setup(ctx) || {};
  room.phaseId = room.game.initialPhase;
  room.status = 'playing';
  broadcast(room);
}

function handleAction(ws, msg) {
  const room = rooms.get(ws.roomCode);
  if (!room || !ws.player || room.status !== 'playing') return;
  const player = room.players.find((p) => p.id === ws.player.id);
  if (!player) return;
  const phase = room.game.phases[room.phaseId];
  const handler = phase.actions && phase.actions[msg.actionId];
  if (!handler) return;
  const ctx = buildCtx(room, player);
  try {
    handler(ctx, player.id, msg.payload || {});
  } catch (err) {
    console.error('Action handler error:', err);
    return send(ws, { type: 'error', message: 'Action failed' });
  }
  broadcast(room);
}

function handleLeave(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room || !ws.player) {
    sendHome(ws);
    return;
  }
  const wasHost = room.hostId === ws.player.id;
  room.players = room.players.filter((p) => p.id !== ws.player.id);
  if (room.players.length === 0) {
    rooms.delete(room.code);
  } else {
    if (wasHost) room.hostId = room.players[0].id;
    broadcast(room);
  }
  ws.roomCode = null;
  ws.player = null;
  sendHome(ws);
}

// ---------- Listen ----------
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log('Multiplayer game server running.');
  console.log(`  Local:    http://localhost:${PORT}`);
  if (ip) console.log(`  Network:  http://${ip}:${PORT}   ← share with friends on the same Wi-Fi`);
});
