# Multiplayer and matchmaking

Status: proposal. Nothing here is built yet.

## Summary

- **Facebook can be a front door, not the multiplayer engine.** Facebook Instant Games gives us players' identity, a way to invite friends and a place to play inside Facebook and Messenger. It doesn't host real-time games or match players up. We need our own game server either way.
- **So build our multiplayer independently of any platform, and add Facebook as one way in.** One authoritative game server runs the existing engine. Players connect over WebSockets. A small identity layer accepts guests first, then Facebook Instant Games, and later anything else (Discord, mobile, our own accounts).
- **Bots make matchmaking easy.** Any empty seat or disconnected player is taken over by the trained model (0.2 ms per move, runs on the server). Tables can start quickly at any population size, and nobody's game dies when someone leaves.

## What Facebook offers now (and the catch)

What I could confirm. `developers.facebook.com` isn't reachable from the build environment, so most of this comes from secondary sources. **Check it against Meta's current docs before committing to anything.**

- **Instant Games is still running.** It's the HTML5 games platform inside Facebook and Messenger, and our TypeScript browser build fits it directly. The current SDK is **v8.0**.
- **"Zero Permissions" is now mandatory.** Facebook Web Games (the old Canvas apps) were shut down on **30 September 2026**. Remaining games had to move to Instant Games with Zero Permissions, and new games need it from day one. The practical effect:
  - **What we get:** the game gets **player IDs only**, plus signed player info so our server can verify who someone is.
  - **What we don't get:** player names, photos and friend lists can't be read by our code, and our server must not store them. Names and photos can only be shown through Facebook's **overlay views**, which Facebook renders from player IDs we pass in.
  - **Network calls:** the game may only call domains on the app's allowlist. That's our server, plus any CDN or font host.
- **Social features:** contexts (a Messenger thread or group the game is played in), sharing, invites and tournaments. Older SDKs had `matchPlayerAsync` for random matching. I couldn't confirm it still exists in v8.0; assume it doesn't.
- **Unity has dropped Instant Games support.** That doesn't affect us, since we're plain TypeScript and HTML.

**What this means for a card table.** The game can't draw "Alice — 14 points" next to a seat itself; seat names would need overlay views. That's workable for a small table but is the biggest UX constraint, so it should be prototyped early. Non-Facebook players (guests, other platforms) would use names they choose, which we can store.

Sources: [Meta Instant Games SDK reference](https://developers.facebook.com/docs/games/build/instant-games/reference/instant-games-sdk/), [Web Games sunset / Zero Permissions (Threads summary)](https://www.threads.com/@mattnavarra/post/DM7subiqnJy/meta-is-kiling-off-web-games-ushers-in-zero-permissions-erameta-is-sunsetting-fa), [Softgames on the September deadline](https://www.softgames.com/own-a-facebook-canvas-game-dont-let-it-disappear-in-september/), [an SDK 8.0 project's constraints](https://github.com/JhnChrstnMabuhayTech/tap-rush-game/pull/5), [Unity deprecation notice](https://discussions.unity.com/t/deprecation-notice-unity-support-for-facebook-instant-games/1694214), [v6.1 docs (matchPlayerAsync)](https://developers.facebook.com/docs/games/instant-games/sdk/fbinstant6.1), [2026 developer guide](https://ilogos.biz/facebook-instant-games-development-guide).

## Architecture

```
 Browser / Instant Games client                Game server (Node, TypeScript)
 ┌──────────────────────────┐   WebSocket    ┌──────────────────────────────────────┐
 │ UI (renders Observation) │ ◄────────────► │ Session/identity  ─ guest | facebook │
 │ sends Move               │                │ Matchmaker        ─ queues, tables   │
 │ FB SDK: login, invites,  │                │ Table             ─ engine GameState │
 │ overlay views for names  │                │                     + bots + timers  │
 └──────────────────────────┘                │ Storage           ─ Postgres (+Redis)│
                                             └──────────────────────────────────────┘
```

- **The server is the only authority.** It holds the full `GameState` and sends each player only `observe(state, seat)`. This is the same boundary the bots already use, so hidden cards never reach a client and cheating by inspecting messages is impossible. The client sends `Move`s, and the server checks them with `applyMove`, which already rejects illegal moves.
- **Same engine everywhere.** Server, client and bots share `src/engine`. Only the UI and the network layer are new.
- **Protocol (small):**
  - client → server: `hello{token}`, `queue{mode, sizes}`, `join{tableId}`, `move{move, seq}`, `leave`
  - server → client: `table{seats, you}`, `obs{observation, deadline}`, `handResult`, `gameOver`, `error`

  Each update carries a full observation (under 2 KB), so reconnecting is just "send the latest".
- **Identity providers:**
  - `guest`: a random ID plus a chosen name, stored in a cookie.
  - `facebook`: the client sends signed player info, and the server verifies the signature with the app secret before trusting the player ID. Only IDs are stored.

  Each provider maps to an internal `userId`, so ratings and history work across platforms.
- **Scale.** A table costs almost nothing (the engine is microseconds per move, the model 0.2 ms), so one Node process can run thousands of tables. Add Redis for queues and presence only when we need more than one server process. ISMCTS bots (around 25 ms per move) should be limited to a "hard" difficulty or run in a worker pool.

## Matchmaking

### Table types
1. **Private table:** created with an invite code or link. On Facebook, a **context** (Messenger thread or group) maps to one table, so everyone opening the game from the same chat lands at the same table. This is the natural Facebook flow and needs no matchmaking.
2. **Quick match:** a public queue.
3. **Practice:** you against bots, offline, entirely client-side (no server needed).

### Quick-match queue
Each queued player gives a mode (`doughnut`, `doughnut-20`) and acceptable table sizes (e.g. 3–6). Every second, the matchmaker:

1. Groups waiting players by mode, then by rating band. The band widens the longer someone waits (e.g. ±100 rating at first, ±400 after 20 s, anything after 40 s).
2. Starts a table when enough players overlap on a table size. It prefers larger tables, up to the preferred size.
3. **After a wait limit (e.g. 15 s), fills the empty seats with bots** at a difficulty near the table's average rating. Real players are never left waiting for a full table.

Tables are always marked "N humans + M bots" so players know. Ranked queues could require at least 2 humans.

### Rating
Doughnut is free-for-all with 2–10 players, so plain Elo doesn't fit. Use a multiplayer Bayesian rating such as **OpenSkill** (Weng-Lin, an open TrueSkill-style system with an npm package), ranked by final placement. Bots get fixed ratings measured by bot-vs-bot tournaments (we already have the harness), which also anchors the scale.

### Turn timer, disconnects and long games
- Each decision has a deadline, e.g. 20 s to play a card and 30 s to play or fold. When it runs out, the server makes the move with the model.
- A disconnected player is played by the bot until they reconnect, then they get their seat back. No more abandoned tables.
- Games are capped at 100 hands already. Online, the 20-hand mode or an even shorter cap is probably the better default, since a 10-player race to zero can take a long time. A "max game length" setting could fit that one.

### Fair play
- Hidden information never leaves the server (see above).
- **Collusion** is the real risk in a free-for-all with friends at one table: two friends can feed each other tricks or signal by chat. Keep ranked tables to solo queue (no parties), and don't put friends together in ranked play. Private tables are unrated, so collusion doesn't matter there.

## Data bonus

Every human game can be logged as (observation, move, outcome). That's exactly the training-data format we already use, so it opens the door to bots that play *like people* (imitation learning) and to spotting where the bots lose to humans.

## Phased plan

1. **Game server plus a web client with guests and private tables (invite links).** Bots fill seats; there's a turn timer and reconnecting. This proves the whole online loop without any platform dependency.
2. **Quick match and ratings:** the queue, rating bands, filling seats with bots, OpenSkill.
3. **A Facebook Instant Games build:** SDK v8.0, signed-player verification on the server, contexts mapped to private tables, invites and sharing, overlay views for names, and our domains on the allowlist. Prototype the overlay-view seat names first, since that's the riskiest piece.
4. Optional: tournaments, other platforms, imitation-learned bots from logged human games.

## Open questions

- Is Facebook the *main* channel, or one of several? If it's the main one, prototype the overlay-view table early.
- Real-time only, or also slow/asynchronous games (play over a day in a Messenger thread)? The server design supports both; the timers differ.
- Ranked play at launch, or casual only?
- Hosting preference: a single small VM is enough for a long time. Managed options would also work.
