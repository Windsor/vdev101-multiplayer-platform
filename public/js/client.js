/**
 * Multiplayer game client.
 *
 *   - Maintains a WebSocket to the server.
 *   - On connect, attempts rejoin using the playerId+code stored in
 *     sessionStorage (so refreshing the tab keeps you in the room).
 *   - Receives "view" messages (the entire screen the user should see)
 *     and renders them.
 *   - Forwards user actions back to the server as { type: 'action', ... }.
 */
(function () {
  'use strict';

  // ---------- DOM helpers ----------
  const app = document.getElementById('app');
  const statusEl = document.getElementById('status');
  const toastEl = document.getElementById('toast');

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(text, kind) {
    if (!text) {
      statusEl.classList.add('hidden');
      return;
    }
    statusEl.textContent = text;
    statusEl.className = `status ${kind || ''}`;
    statusEl.classList.remove('hidden');
  }

  let toastTimer;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
  }

  // ---------- Identity persistence ----------
  const SESSION_KEY = 'imposter:identity';
  function saveIdentity(code, playerId, name) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, playerId, name }));
  }
  function loadIdentity() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  }
  function clearIdentity() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ---------- Local UI state (only what's needed before first view) ----------
  let lastView = null;
  let savedName = localStorage.getItem('imposter:name') || '';

  // ---------- WebSocket ----------
  let ws = null;
  let reconnectAttempt = 0;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.addEventListener('open', () => {
      reconnectAttempt = 0;
      setStatus(null);
      const id = loadIdentity();
      if (id && id.code && id.playerId) {
        send({ type: 'rejoin', code: id.code, playerId: id.playerId });
      }
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handleServer(msg);
    });

    ws.addEventListener('close', () => {
      setStatus('Disconnected — reconnecting…', 'warn');
      const delay = Math.min(8000, 500 * 2 ** reconnectAttempt++);
      setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => {
      // 'close' fires too; nothing extra to do
    });
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function handleServer(msg) {
    if (msg.type === 'view') {
      lastView = msg.view;
      render(msg.view);
    } else if (msg.type === 'identity') {
      const prev = loadIdentity() || {};
      saveIdentity(msg.code, msg.playerId, prev.name || savedName);
    } else if (msg.type === 'error') {
      toast(msg.message || 'Something went wrong');
    }
  }

  // ---------- Render ----------
  function render(view) {
    if (!view) return;
    if (view.screen === 'home') return renderHome(view);
    if (view.screen === 'lobby') return renderLobby(view);
    if (view.screen === 'playing') return renderPlaying(view);
    app.innerHTML = '';
  }

  function renderHome(view) {
    const games = view.games || [];
    const gameOptions = games
      .map(
        (g) =>
          `<option value="${esc(g.id)}">${esc(g.name)} (${g.minPlayers}–${g.maxPlayers})</option>`
      )
      .join('');

    app.innerHTML = `
      <header class="header">
        <h1>Imposter Who?</h1>
        <p class="subtitle">Multiplayer · multiple devices</p>
      </header>
      <main class="home">
        <section class="card">
          <h3>Create a room</h3>
          <form data-form="create" class="stack">
            <label class="field">
              <span>Your name</span>
              <input name="name" maxlength="20" autocomplete="off" required value="${esc(savedName)}" />
            </label>
            <label class="field">
              <span>Game</span>
              <select name="gameId">${gameOptions}</select>
            </label>
            <button type="submit" class="primary big">Create room</button>
          </form>
        </section>
        <section class="card">
          <h3>Join a room</h3>
          <form data-form="join" class="stack">
            <label class="field">
              <span>Your name</span>
              <input name="name" maxlength="20" autocomplete="off" required value="${esc(savedName)}" />
            </label>
            <label class="field">
              <span>Room code</span>
              <input name="code" maxlength="4" autocomplete="off" required
                     style="text-transform:uppercase; letter-spacing:.4em; text-align:center; font-weight:700;"
                     placeholder="ABCD" />
            </label>
            <button type="submit" class="primary big">Join</button>
          </form>
        </section>
        <footer class="footer">Open this URL on each player's phone or laptop. They join with the room code.</footer>
      </main>
    `;
    bindHomeForms();
  }

  function bindHomeForms() {
    app.querySelector('[data-form="create"]').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      const name = (data.name || '').trim();
      if (!name) return;
      savedName = name;
      localStorage.setItem('imposter:name', name);
      send({ type: 'create', name, gameId: data.gameId });
    });
    app.querySelector('[data-form="join"]').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      const name = (data.name || '').trim();
      const code = String(data.code || '').toUpperCase().trim();
      if (!name || !code) return;
      savedName = name;
      localStorage.setItem('imposter:name', name);
      send({ type: 'join', name, code });
    });
  }

  function renderLobby(view) {
    const playerList = view.players
      .map(
        (p) => `
        <li class="player-row ${p.connected ? '' : 'dim'}">
          <span>${esc(p.name)}${p.isHost ? ' <span class="role-tag">host</span>' : ''}</span>
          ${p.connected ? '' : '<span class="muted small">offline</span>'}
        </li>`
      )
      .join('');

    const fields = (view.game.configSchema || [])
      .map((f) => {
        const val = view.config[f.key];
        const disabled = view.me.isHost ? '' : 'disabled';
        if (f.type === 'select') {
          const opts = f.options
            .map(
              (o) =>
                `<option value="${esc(o.value)}" ${
                  String(val) === String(o.value) ? 'selected' : ''
                }>${esc(o.label)}</option>`
            )
            .join('');
          return `
            <label class="field">
              <span>${esc(f.label)}</span>
              <select data-config="${esc(f.key)}" ${disabled}>${opts}</select>
            </label>`;
        }
        if (f.type === 'number') {
          return `
            <label class="field">
              <span>${esc(f.label)}</span>
              <input type="number" min="${f.min ?? 1}" max="${f.max ?? 99}"
                     value="${val}" data-config="${esc(f.key)}" ${disabled} />
            </label>`;
        }
        return '';
      })
      .join('');

    app.innerHTML = `
      <header class="header">
        <button class="link back" data-action="leave">← leave</button>
        <h1>${esc(view.game.name)}</h1>
      </header>
      <main class="lobby">
        <section class="card code-card">
          <p class="muted small">Room code</p>
          <p class="room-code">${esc(view.code)}</p>
          <p class="muted small">Players join from their own device with this code.</p>
        </section>
        <section class="card">
          <h3>Players (${view.players.length}/${view.game.maxPlayers})</h3>
          <ul class="player-list">${playerList || '<li class="muted">No players yet.</li>'}</ul>
        </section>
        ${
          fields
            ? `<section class="card"><h3>Settings</h3><div class="fields">${fields}</div>${
                view.me.isHost ? '' : '<p class="muted small">Only the host can change settings.</p>'
              }</section>`
            : ''
        }
        ${
          view.me.isHost
            ? `<button class="primary big" data-action="start" ${view.canStart ? '' : 'disabled'}>
                 ${view.canStart ? 'Start game' : `Need at least ${view.game.minPlayers} players`}
               </button>`
            : `<p class="muted center">Waiting for host to start…</p>`
        }
      </main>
    `;
    bindLobby();
  }

  function bindLobby() {
    app.querySelectorAll('[data-config]').forEach((el) => {
      el.addEventListener('change', () => {
        send({ type: 'set-config', key: el.dataset.config, value: el.value });
      });
    });
    app.querySelectorAll('[data-action]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const action = el.dataset.action;
        if (action === 'start') return send({ type: 'start' });
        if (action === 'leave') {
          if (confirm('Leave the room?')) {
            clearIdentity();
            send({ type: 'leave' });
          }
        }
      });
    });
  }

  function renderPlaying(view) {
    const sections = view.sections || [];
    const inner = sections.map(renderSection).join('');
    const playerStrip = view.players
      .map(
        (p) =>
          `<span class="chip ${p.connected ? '' : 'dim'} ${p.id === view.me.id ? 'me' : ''}">${esc(p.name)}</span>`
      )
      .join('');

    app.innerHTML = `
      <header class="header">
        <button class="link back" data-action="leave">← leave</button>
        <h1>${esc(view.game.name)}</h1>
        <span class="code-pill">${esc(view.code)}</span>
      </header>
      <main class="play">
        <div class="player-strip">${playerStrip}</div>
        <div class="play-body">${inner}</div>
      </main>
    `;
    bindPlaying();
  }

  function renderSection(s) {
    if (!s) return '';
    switch (s.type) {
      case 'header':
        return `<h2 class="section-header">${esc(s.text)}</h2>`;
      case 'paragraph':
        return `<p${s.muted ? ' class="muted"' : ''}>${esc(s.text)}</p>`;
      case 'progress':
        return `<p class="progress"><span class="dot"></span> ${esc(s.text)}</p>`;
      case 'role-card':
        return `
          <div class="word-card${s.danger ? ' imposter' : ''}">
            <span class="label">${esc(s.label)}</span>
            <span class="word">${esc(s.value)}</span>
            ${s.description ? `<small>${esc(s.description)}</small>` : ''}
          </div>`;
      case 'action':
        return `<button class="primary big" data-action="${esc(s.actionId)}" ${s.disabled ? 'disabled' : ''}>${esc(s.label)}</button>`;
      case 'choices':
        return `
          <div class="vote-grid">
            ${s.options
              .map(
                (o) =>
                  `<button class="vote-choice" data-action="${esc(s.actionId)}" data-value="${esc(o.value)}">${esc(o.label)}</button>`
              )
              .join('')}
          </div>`;
      case 'form': {
        const fields = s.fields
          .map(
            (f) =>
              `<input name="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}" maxlength="${f.maxlength || 100}" autocomplete="off" required />`
          )
          .join('');
        return `
          <form class="play-form" data-action="${esc(s.actionId)}">
            ${fields}
            <button type="submit" class="primary">${esc(s.submitLabel || 'Submit')}</button>
          </form>`;
      }
      case 'list':
        return `<ul class="clue-list">${s.items.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ul>`;
      case 'tally':
        return `<ul class="tally">${s.items
          .map(
            (i) => `
          <li class="${i.highlight ? 'top' : ''}">
            <span>${esc(i.label)}</span>
            <span class="bar" style="--n:${i.count}"></span>
            <span class="count">${i.count}</span>
          </li>`
          )
          .join('')}</ul>`;
      default:
        return '';
    }
  }

  function bindPlaying() {
    // Action buttons (and choice buttons, which carry data-value)
    app.querySelectorAll('button[data-action]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const action = el.dataset.action;
        if (action === 'leave') {
          if (confirm('Leave the game?')) {
            clearIdentity();
            send({ type: 'leave' });
          }
          return;
        }
        const payload = {};
        if (el.dataset.value !== undefined) payload.value = el.dataset.value;
        send({ type: 'action', actionId: action, payload });
      });
    });
    // Forms
    app.querySelectorAll('form[data-action]').forEach((form) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        send({ type: 'action', actionId: form.dataset.action, payload: data });
        form.reset();
      });
    });
  }

  // ---------- Boot ----------
  connect();
})();
