/**
 * Imposter Who? — multiplayer (true multi-device).
 *
 * Server-authoritative. Each phase exposes:
 *   - getView(ctx): returns view sections for THIS player only
 *     (private info filtered server-side; client receives only what it
 *     should know).
 *   - actions: handlers run on the server with the acting player's id.
 *     Use ctx.goTo(phaseId) to advance phases.
 *
 * Sections are a small generic UI vocabulary the client knows how to render:
 *   { type: 'header', text }
 *   { type: 'paragraph', text, muted? }
 *   { type: 'role-card', label, value, description?, danger? }
 *   { type: 'action', actionId, label, disabled?, secondary? }
 *   { type: 'choices', actionId, options: [{label, value}] }
 *   { type: 'form', actionId, fields: [{name, placeholder, maxlength}], submitLabel }
 *   { type: 'list', items: [{text}] }
 *   { type: 'tally', items: [{label, count, highlight}] }
 *   { type: 'progress', text }
 */
const WORD_CATEGORIES = require('./words');

const Imposter = {
  id: 'imposter',
  name: 'Imposter Who?',
  description: "Everyone sees the same secret word — except the imposter. Give a clue. Vote.",
  minPlayers: 3,
  maxPlayers: 15,
  initialPhase: 'reveal',

  configSchema: [
    {
      key: 'category',
      label: 'Category',
      type: 'select',
      default: 'mixed',
      options: [
        { value: 'mixed', label: 'Mixed (all)' },
        ...WORD_CATEGORIES.map((c) => ({ value: c.id, label: c.name })),
      ],
    },
    {
      key: 'imposters',
      label: 'Imposters',
      type: 'number',
      default: 1,
      min: 1,
      max: 3,
    },
  ],

  setup(ctx) {
    const pool =
      ctx.config.category === 'mixed'
        ? WORD_CATEGORIES.flatMap((c) =>
            c.words.map((w) => ({ word: w, category: c.name }))
          )
        : (() => {
            const c = WORD_CATEGORIES.find((x) => x.id === ctx.config.category);
            return c ? c.words.map((w) => ({ word: w, category: c.name })) : [];
          })();

    const pick = ctx.randomFrom(pool);
    const numImposters = Math.min(
      Math.max(1, parseInt(ctx.config.imposters, 10) || 1),
      Math.max(1, ctx.players.length - 2)
    );
    const shuffled = ctx.shuffle(ctx.players);
    const imposterIds = shuffled.slice(0, numImposters).map((p) => p.id);
    const order = ctx.shuffle(ctx.players).map((p) => p.id);

    return {
      secret: pick.word,
      category: pick.category,
      imposterIds,
      order,
      readyFor: [],
      currentClueGiver: 0,
      clues: [],
      votes: {},
      result: null,
    };
  },

  phases: {
    // ---- 1. Each player privately sees their own role on their own device ----
    reveal: {
      getView(ctx) {
        const { state, me, players } = ctx;
        const isImposter = state.imposterIds.includes(me.id);
        const isReady = state.readyFor.includes(me.id);
        const readyCount = state.readyFor.length;
        const total = players.length;

        const card = isImposter
          ? {
              type: 'role-card',
              label: 'You are the',
              value: 'IMPOSTER',
              description:
                "You don't know the word. Bluff your clue. Don't get caught.",
              danger: true,
            }
          : {
              type: 'role-card',
              label: `Secret word — ${state.category}`,
              value: state.secret,
              description: 'Give a clue that proves you know it, without giving it away.',
            };

        const sections = [card];
        if (!isReady) {
          sections.push({ type: 'action', actionId: 'ready', label: "I'm ready" });
        } else {
          sections.push({
            type: 'progress',
            text: `Waiting for others… (${readyCount}/${total})`,
          });
        }
        sections.push({
          type: 'paragraph',
          text: `${readyCount} of ${total} ready`,
          muted: true,
        });
        return sections;
      },
      actions: {
        ready(ctx, playerId) {
          if (!ctx.state.readyFor.includes(playerId)) {
            ctx.state.readyFor.push(playerId);
          }
          if (ctx.state.readyFor.length >= ctx.players.length) {
            ctx.goTo('clues');
          }
        },
      },
    },

    // ---- 2. Players give one-word clues in turn order, each on their own device ----
    clues: {
      getView(ctx) {
        const { state, me, players } = ctx;
        const idx = state.currentClueGiver;
        const allDone = idx >= state.order.length;

        const cluesItems = state.clues.map((c) => {
          const p = players.find((x) => x.id === c.playerId);
          return { text: `${p ? p.name : '?'}: ${c.text}` };
        });

        if (allDone) {
          const sections = [
            { type: 'header', text: 'All clues given' },
            { type: 'list', items: cluesItems },
          ];
          if (me.isHost) {
            sections.push({ type: 'action', actionId: 'to-vote', label: 'Start voting →' });
          } else {
            sections.push({
              type: 'progress',
              text: 'Waiting for the host to start the vote…',
            });
          }
          return sections;
        }

        const currentId = state.order[idx];
        const isMe = currentId === me.id;
        const currentName = (players.find((p) => p.id === currentId) || {}).name || '?';

        const sections = [
          {
            type: 'header',
            text: `Clue ${idx + 1} of ${state.order.length}`,
          },
        ];
        if (isMe) {
          sections.push({
            type: 'paragraph',
            text: "It's your turn. Say one word out loud and submit it.",
          });
          sections.push({
            type: 'form',
            actionId: 'submit-clue',
            fields: [
              {
                name: 'text',
                placeholder: 'one word…',
                maxlength: 30,
              },
            ],
            submitLabel: 'Submit clue',
          });
        } else {
          sections.push({
            type: 'progress',
            text: `${currentName} is giving their clue…`,
          });
        }
        if (cluesItems.length) {
          sections.push({ type: 'list', items: cluesItems });
        }
        return sections;
      },
      actions: {
        'submit-clue'(ctx, playerId, payload) {
          const idx = ctx.state.currentClueGiver;
          if (ctx.state.order[idx] !== playerId) return; // not your turn
          const text = String(payload.text || '').trim().slice(0, 30);
          if (!text) return;
          ctx.state.clues.push({ playerId, text });
          ctx.state.currentClueGiver += 1;
        },
        'to-vote'(ctx, playerId) {
          if (!ctx.me.isHost) return;
          ctx.goTo('vote');
        },
      },
    },

    // ---- 3. Each player privately votes on their own device ----
    vote: {
      getView(ctx) {
        const { state, me, players } = ctx;
        const myVote = state.votes[me.id];
        const totalVotes = Object.keys(state.votes).length;
        const total = players.length;

        const cluesItems = state.clues.map((c) => {
          const p = players.find((x) => x.id === c.playerId);
          return { text: `${p ? p.name : '?'}: ${c.text}` };
        });

        if (myVote) {
          const target = players.find((p) => p.id === myVote);
          const sections = [
            { type: 'header', text: 'Vote received' },
            {
              type: 'paragraph',
              text: `You voted for ${target ? target.name : '?'}.`,
            },
            {
              type: 'progress',
              text: `${totalVotes} of ${total} voted`,
            },
          ];
          if (cluesItems.length) sections.push({ type: 'list', items: cluesItems });
          if (me.isHost && totalVotes >= total) {
            sections.push({ type: 'action', actionId: 'tally', label: 'Reveal results →' });
          }
          return sections;
        }

        return [
          { type: 'header', text: 'Who is the imposter?' },
          {
            type: 'choices',
            actionId: 'cast-vote',
            options: players
              .filter((p) => p.id !== me.id)
              .map((p) => ({ label: p.name, value: p.id })),
          },
          { type: 'paragraph', text: `${totalVotes} of ${total} voted`, muted: true },
          ...(cluesItems.length ? [{ type: 'list', items: cluesItems }] : []),
        ];
      },
      actions: {
        'cast-vote'(ctx, playerId, payload) {
          if (!payload || !payload.value) return;
          if (payload.value === playerId) return; // can't vote yourself
          ctx.state.votes[playerId] = payload.value;
        },
        tally(ctx) {
          if (!ctx.me.isHost) return;
          const tally = {};
          Object.values(ctx.state.votes).forEach((t) => {
            tally[t] = (tally[t] || 0) + 1;
          });
          const max = Math.max(...Object.values(tally), 0);
          const accused = Object.keys(tally).filter((k) => tally[k] === max);
          const tied = accused.length > 1;
          const caught = !tied && ctx.state.imposterIds.includes(accused[0]);
          ctx.state.result = { tally, accused, tied, caught };
          ctx.goTo('results');
        },
      },
    },

    // ---- 4. Reveal & outcome ----
    results: {
      getView(ctx) {
        const { state, me, players } = ctx;
        const r = state.result;
        const imposters = state.imposterIds
          .map((id) => (players.find((p) => p.id === id) || {}).name)
          .filter(Boolean)
          .join(', ');
        const headline = r.tied
          ? '🤝 Tie — imposter escapes!'
          : r.caught
          ? '🎯 Imposter caught!'
          : '🕵️ Imposter wins!';

        const sections = [
          { type: 'header', text: headline },
          {
            type: 'paragraph',
            text: `Secret: ${state.secret} (${state.category})`,
          },
          {
            type: 'paragraph',
            text: `Imposter${state.imposterIds.length > 1 ? 's' : ''}: ${imposters}`,
          },
          {
            type: 'tally',
            items: players.map((p) => ({
              label: p.name,
              count: r.tally[p.id] || 0,
              highlight: r.accused.includes(p.id),
            })),
          },
        ];
        if (me.isHost) {
          sections.push({
            type: 'action',
            actionId: 'play-again',
            label: 'Play again',
          });
        } else {
          sections.push({
            type: 'progress',
            text: 'Waiting for host to start a new round…',
          });
        }
        return sections;
      },
      actions: {
        'play-again'(ctx) {
          if (!ctx.me.isHost) return;
          const fresh = Imposter.setup(ctx);
          Object.keys(ctx.state).forEach((k) => delete ctx.state[k]);
          Object.assign(ctx.state, fresh);
          ctx.goTo('reveal');
        },
      },
    },
  },
};

module.exports = Imposter;
