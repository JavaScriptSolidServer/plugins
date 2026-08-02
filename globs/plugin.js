// NEONGLOBS realtime match server as a #206 loader plugin.
//
//   plugins: [{ id: 'globs', module: 'globs/plugin.js', prefix: '/globs' }]
//
// The game (https://melvincarvalho.github.io/neonglobs/) is a Globulos
// tribute: each round both sides secretly commit one aim-arrow per glob,
// then a deterministic physics pass resolves everything at once. That
// commit-then-resolve loop is what makes a server cheap: one small message
// per round, no tick streaming, and the server re-runs the same pure sim
// (vendored ./sim.js, parity-tested against the browser build bit-for-bit)
// as the single authority for goals, deaths, and ELO.
//
//   WS   {prefix}/play         the match protocol (below)
//   GET  {prefix}/leaderboard  { top: [{agent, rating, games, wins, losses}], players }
//
// Protocol (JSON messages over the socket):
//   → hello   { token? }             optional bearer for browsers (headers can't
//                                    ride a browser WS upgrade); node clients may
//                                    instead send Authorization on the upgrade
//   ← welcome { agent, rating }      agent null = guest (casual play only)
//   → queue   { bot?: 0|1|2 }        bot level for an instant AI match; omit to
//                                    wait for a human (bot fallback after 10s)
//   ← queued  {}
//   ← matched { matchId, side, opponent: { name, rating, bot } , aimMs }
//   ← phase   { round, deadline, state }         state = { globs, ball, score }
//   → commit  { round, commits }     { globIdx: {vx, vy} } — validated server-side
//   ← reveal  { round, commits }     both sides' arrows, for local animation
//   ← result  { round, scorer, score, deaths, state }
//   ← matchEnd{ winner, score, forfeit?, elo: { old, new } | null }
//   ← error   { code }
//
// Identity: api.auth.getAgent on the upgrade request, else hello.token
// verified through the same getAgent with a synthetic request (bearer
// verification only reads headers — auth.js docs). Ranked ELO requires an
// agent on both sides (bots count: they hold fixed anchor ratings).
// Disconnecting mid-match forfeits it.
//
// Persistence (api.storage.pluginDir): elo.json (atomic tmp+rename),
// matches.jsonl (append-only log).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAgent } from 'javascript-solid-server/auth.js';
import {
  makeMatch, applyRound, botCommits, validateCommits, AIM_TIME, WIN_SCORE,
} from './sim.js';

const BOTS = [
  { name: 'EASY BOT', level: 0, rating: 800 },
  { name: 'MEDIUM BOT', level: 1, rating: 1100 },
  { name: 'HARD BOT', level: 2, rating: 1400 },
];
const START_RATING = 1200;
const K_HUMAN = 32, K_BOT = 16;
const QUEUE_BOT_FALLBACK_MS = 10_000;
const RESOLVE_GRACE_MS = 2_000;

export async function activate(api) {
  const prefix = api.prefix || '/globs';
  const aimMs = api.config.aimTimeMs ?? AIM_TIME * 1000;
  const dir = api.storage.pluginDir();
  const eloFile = path.join(dir, 'elo.json');
  const logFile = path.join(dir, 'matches.jsonl');

  // ---------- ratings ----------
  let elo = { players: {} };
  try { elo = JSON.parse(fs.readFileSync(eloFile, 'utf8')); } catch { /* fresh */ }
  function saveElo() {
    const tmp = eloFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(elo, null, 2));
    fs.renameSync(tmp, eloFile);
  }
  function ratingOf(agent) { return elo.players[agent]?.rating ?? START_RATING; }
  function record(agent, delta, won) {
    const p = elo.players[agent] ?? { rating: START_RATING, games: 0, wins: 0, losses: 0 };
    p.rating = Math.round(p.rating + delta);
    p.games++;
    if (won) p.wins++; else p.losses++;
    elo.players[agent] = p;
  }
  // ---------- match rooms ----------
  const sockets = new Set();
  const waiting = [];                       // [{ socket, ctx, timer }]
  const rooms = new Map();                  // matchId -> room

  function send(socket, msg) {
    try { socket.send(JSON.stringify(msg)); } catch { /* gone */ }
  }

  function publicState(st) {
    return {
      globs: st.globs.map(g => ({ team: g.team, idx: g.idx, x: g.x, y: g.y, dead: !!g.dead })),
      ball: { x: st.ball.x, y: st.ball.y },
      score: st.score,
      round: st.round,
    };
  }

  function startRoom(a, b) {
    // a, b: { socket|null, ctx: { agent, name }, botLevel? } — b may be a bot
    const matchId = crypto.randomBytes(8).toString('hex');
    const seed = crypto.randomBytes(4).readUInt32BE(0) || 1;
    const room = {
      id: matchId, seed,
      st: makeMatch(seed),
      sides: [a, b],
      commits: [null, null],
      timer: null,
      done: false,
    };
    rooms.set(matchId, room);
    for (const [side, s] of room.sides.entries()) {
      if (!s.socket) continue;
      s.room = room; s.side = side;
      const opp = room.sides[1 - side];
      send(s.socket, {
        type: 'matched', matchId, side, aimMs,
        opponent: { name: opp.ctx.name, rating: opp.botLevel != null ? BOTS[opp.botLevel].rating : ratingOf(opp.ctx.agent), bot: opp.botLevel != null ? BOTS[opp.botLevel].level : undefined },
        you: { rating: s.ctx.agent ? ratingOf(s.ctx.agent) : null },
      });
    }
    beginPhase(room);
    return room;
  }

  function beginPhase(room) {
    room.commits = [null, null];
    // bots commit at phase start — they cannot peek at the opponent
    for (const [side, s] of room.sides.entries()) {
      if (s.botLevel != null) room.commits[side] = botCommits(room.st, side, 'ai', s.botLevel);
    }
    const deadline = Date.now() + aimMs + RESOLVE_GRACE_MS;
    for (const s of room.sides) {
      if (s.socket) send(s.socket, { type: 'phase', round: room.st.round, deadline, state: publicState(room.st) });
    }
    room.timer = setTimeout(() => resolveRound(room), aimMs + RESOLVE_GRACE_MS);
  }

  function resolveRound(room) {
    if (room.done) return;
    clearTimeout(room.timer);
    const commits = [room.commits[0] ?? {}, room.commits[1] ?? {}];
    for (const s of room.sides) {
      if (s.socket) send(s.socket, { type: 'reveal', round: room.st.round, commits });
    }
    const { scorer, end } = applyRound(room.st, commits);
    const deaths = room.st.globs.filter(g => g.dead).map(g => ({ team: g.team, idx: g.idx }));
    for (const s of room.sides) {
      if (s.socket) send(s.socket, { type: 'result', round: room.st.round - 1, scorer, score: room.st.score, deaths, state: publicState(room.st) });
    }
    if (end) endRoom(room, room.st.winner, false);
    else beginPhase(room);
  }

  function endRoom(room, winner, forfeit) {
    if (room.done) return;
    room.done = true;
    clearTimeout(room.timer);
    rooms.delete(room.id);
    // ELO: both sides need an identity; bots use their fixed anchors
    const deltas = [null, null];
    const [a, b] = room.sides;
    const idOf = s => (s.botLevel != null ? `bot:${BOTS[s.botLevel].name}` : s.ctx.agent);
    const rated = s => s.botLevel != null || !!s.ctx.agent;
    if (rated(a) && rated(b) && winner >= 0) {
      // deltas from PRE-match ratings for both sides, then apply — otherwise
      // the second player's expectation would see the first one's new rating
      const pre = room.sides.map(s => s.botLevel != null ? BOTS[s.botLevel].rating : ratingOf(s.ctx.agent));
      for (const side of [0, 1]) {
        const me = room.sides[side], opp = room.sides[1 - side];
        if (me.botLevel != null) continue;                       // anchors never move
        const k = opp.botLevel != null ? K_BOT : K_HUMAN;
        const expected = 1 / (1 + Math.pow(10, (pre[1 - side] - pre[side]) / 400));
        const delta = k * ((side === winner ? 1 : 0) - expected);
        deltas[side] = { old: pre[side], new: Math.round(pre[side] + delta) };
        record(me.ctx.agent, delta, side === winner);
      }
      saveElo();
    }
    try {
      fs.appendFileSync(logFile, JSON.stringify({
        t: new Date().toISOString(), id: room.id, seed: room.seed,
        sides: room.sides.map(idOf), score: room.st.score, winner, forfeit, rounds: room.st.rounds,
      }) + '\n');
    } catch (e) { api.log.warn?.(`globs: match log failed: ${e.message}`); }
    for (const [side, s] of room.sides.entries()) {
      if (!s.socket) continue;
      send(s.socket, { type: 'matchEnd', winner, score: room.st.score, forfeit: forfeit || undefined, elo: deltas[side] });
      s.room = null;
    }
  }

  function tryPair() {
    while (waiting.length >= 2) {
      const a = waiting.shift(), b = waiting.shift();
      clearTimeout(a.timer); clearTimeout(b.timer);
      startRoom(a, b);
    }
  }

  function queueBotMatch(entry, level) {
    const i = waiting.indexOf(entry);
    if (i >= 0) waiting.splice(i, 1);
    clearTimeout(entry.timer);
    const bot = BOTS[level] ?? BOTS[1];
    startRoom(entry, { socket: null, ctx: { agent: null, name: bot.name }, botLevel: bot.level });
  }

  // ---------- the play socket ----------
  await api.ws.route(`${prefix}/play`, async (socket, request) => {
    sockets.add(socket);
    const entry = { socket, ctx: { agent: null, name: 'GUEST' }, timer: null, room: null, side: -1 };
    const pending = [];
    let ready = false;

    // header credentials (node clients); browsers use hello{token}
    let agent = await getAgent(request);
    finishAuth(agent);

    function finishAuth(a) {
      if (a) {
        entry.ctx.agent = a;
        entry.ctx.name = a.replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 40) || a.slice(0, 40);
      }
      if (!ready) {
        ready = true;
        send(socket, { type: 'welcome', agent: entry.ctx.agent, rating: entry.ctx.agent ? ratingOf(entry.ctx.agent) : null });
        for (const m of pending.splice(0)) handleMessage(m);
      }
    }

    async function handleMessage(msg) {
      if (msg.type === 'hello') {
        if (msg.token && !entry.ctx.agent) {
          // bearer verification reads only headers (auth.js contract), so a
          // synthetic request is enough to lift a browser token to an agent
          const a = await getAgent({
            headers: { authorization: `Bearer ${msg.token}` },
            method: 'GET', url: `${prefix}/play`, protocol: 'http', hostname: 'localhost',
          });
          if (a) {
            entry.ctx.agent = a;
            entry.ctx.name = a.replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 40);
          }
        }
        send(socket, { type: 'welcome', agent: entry.ctx.agent, rating: entry.ctx.agent ? ratingOf(entry.ctx.agent) : null });
        return;
      }
      if (msg.type === 'queue') {
        if (entry.room) { send(socket, { type: 'error', code: 'already-in-match' }); return; }
        if (msg.bot != null) { queueBotMatch(entry, Math.max(0, Math.min(2, msg.bot | 0))); return; }
        waiting.push(entry);
        send(socket, { type: 'queued' });
        entry.timer = setTimeout(() => {
          if (waiting.includes(entry)) queueBotMatch(entry, 1);
        }, api.config.queueBotFallbackMs ?? QUEUE_BOT_FALLBACK_MS);
        tryPair();
        return;
      }
      if (msg.type === 'commit') {
        const room = entry.room;
        if (!room || room.done) return;
        if (msg.round !== room.st.round) return;
        room.commits[entry.side] = validateCommits(room.st, entry.side, msg.commits);
        const allIn = room.sides.every((s, i) => s.botLevel != null || room.commits[i] != null);
        if (allIn) resolveRound(room);
        return;
      }
      if (msg.type === 'leave') {
        if (entry.room) endRoom(entry.room, 1 - entry.side, true);
        socket.close();
      }
    }

    socket.on('message', data => {
      let msg;
      try { msg = JSON.parse(String(data).slice(0, 64 * 1024)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (!ready) { pending.push(msg); return; }
      handleMessage(msg).catch(e => api.log.warn?.(`globs: ${e.message}`));
    });

    socket.on('close', () => {
      sockets.delete(socket);
      const i = waiting.indexOf(entry);
      if (i >= 0) { waiting.splice(i, 1); clearTimeout(entry.timer); }
      if (entry.room && !entry.room.done) endRoom(entry.room, 1 - entry.side, true);   // disconnect = forfeit
    });
  });

  // keepalive: proxies love to reap idle sockets mid-aim
  const pinger = setInterval(() => {
    for (const s of sockets) { try { s.ping?.(); } catch { /* gone */ } }
  }, 30_000);

  // ---------- leaderboard ----------
  api.fastify.get(`${prefix}/leaderboard`, async () => {
    const top = Object.entries(elo.players)
      .map(([agent, p]) => ({ agent, ...p }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 50);
    return { top, players: Object.keys(elo.players).length, bots: BOTS };
  });

  api.log.info?.(`globs: match server at ws://…${prefix}/play, leaderboard at ${prefix}/leaderboard`);

  return {
    deactivate() {
      clearInterval(pinger);
      for (const room of rooms.values()) { clearTimeout(room.timer); room.done = true; }
      for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
    },
  };
}
