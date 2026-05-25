# VDev Arena — Multiplayer Game Platform

A complete, LAN-friendly real-time multiplayer party game platform built from `Windsor/vDev101/003-multiplayer`.

The first included game is **Imposter Who?**: every player joins from their own device, receives private role information, gives clues in turn, votes, and sees server-authoritative results.

## Features

- Real-time WebSocket rooms with four-character join codes
- Server-authoritative game state and private per-player views
- Rejoin support after refresh via session storage
- Host-controlled lobby settings and round start
- One-tap SMS invite link from the lobby with room code and current URL
- Configurable clue rounds before voting, defaulting to 2 and capped at 3
- Automatic result resolution as soon as every player votes
- Mobile-friendly Nocturne-style dark technical UI
- Health endpoint at `/health`
- Automated unit tests plus a full multi-client smoke test

## Run locally

```bash
npm install
npm start
```

The server binds to `0.0.0.0` and prints both local and LAN URLs.

## Test

```bash
npm test
```

## Smoke test the full multiplayer flow

Terminal 1:

```bash
PORT=8765 npm start
```

Terminal 2:

```bash
PORT=8765 node smoke.js
```

## Game architecture

- `server.js`: Express static server + WebSocket room lifecycle
- `games/registry.js`: register available games
- `games/imposter.js`: server-side game definition, setup, phases, actions, private views
- `public/js/client.js`: generic client renderer for server-sent view sections
- `public/css/styles.css`: Nocturne-inspired visual system

To add another game, create a new module in `games/` with `setup`, `initialPhase`, `phases`, and `configSchema`, then add it to `games/registry.js`.
