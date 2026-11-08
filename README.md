# Doughnut

A settings-driven trick-taking card game engine with AI opponents, in TypeScript. Built to run in the browser (no server needed for the AI).

## Layout

```
src/engine/   rules engine (pure, no I/O)
  config.ts       GameConfig: the settings that describe a game mode
  modes.ts        built-in modes (doughnut, doughnut-20)
  rules.ts        rule plugins: effectiveSuit / trickRank / trick winner
  game.ts         state, legal moves, applying moves, scoring
  observation.ts  what one player can see + determinize() for the AI
src/ai/       agents: random, heuristic, ismcts
src/ml/       self-play training
  mlp.ts          dependency-free neural net (same code in Node and browser)
  features.ts     the shared encoding of an observation + move
  dmc.ts          Deep Monte Carlo agent
  train*.ts       self-play training loop (single-threaded and worker threads)
  distill.ts      learning from ISMCTS (data generation + supervised training)
  dataset.ts      compact binary format for search data
src/runner.ts play a full game with one agent per seat
src/cli/      tournament, terminal play, training
scripts/      one-off analysis (game length, profiling)
```

Agents only receive an `Observation` (their own hand + public info), never the full state, so no bot can cheat.

## Play online / deploy

`npm run build` produces everything the host needs:

```
dist/server.cjs      the whole server in one file (ws included, no native modules)
dist/public/         the web client (index.html, app.js, styles.css, models/doughnut.json)
models/doughnut.json the bots' model (read by the server)
```

Run with `node dist/server.cjs` (or `npm start`) from the project folder. Settings come from environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | 3000 | port to listen on (most hosts set this) |
| `APP_ROOT` | current directory | where `dist/` and `models/` live |
| `PUBLIC_DIR` | `$APP_ROOT/dist/public` | |
| `MODEL_PATH` | `$APP_ROOT/models/doughnut.json` | without it, bots use the heuristic |
| `PUBLIC_URL` | `http://localhost:$PORT` | the site's address, used in email links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `SMTP_SECURE` | none | outgoing email; without it emails go to the log |
| `DATABASE_URL` | none | `mysql://user:password@host:3306/dbname` |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | none | alternative to `DATABASE_URL` |

### Players, accounts and email

- **Guests:** anyone can play straight away by picking a nickname. Nothing about a guest is saved: no player row, no history, no rating. In saved games, guest seats are stored only as "Guest".
- **Sign up:** email, password, and the nickname others see (unique, ignoring capitals; "Guest" is reserved). We email a **confirmation link**. Until it's opened the player stays a guest. Opening it, on any device, confirms the account and logs that browser in. The browser that signed up is logged in at the same moment if it's still connected, and if it's mid-game, that game counts. Unconfirmed sign-ups are deleted after 48 hours, freeing the nickname. Guests can't use a confirmed account's nickname.
- **Log in** with email or nickname, plus password. Logging in and out is blocked during a game.
- **Forgot password:** enter your email to get a link that works once, for 1 hour. Setting a new password logs out every other device.
- **Privacy:** sign-up and "forgot password" answer the same whether or not an email has an account, so nobody can probe for accounts. If someone signs up with an email that already has an account, its owner gets an email saying so, with a reset link.
- **Security:**
  - passwords are hashed with scrypt (salted, Node built-in)
  - email links are random, single-use, and stored only as SHA-256 hashes
  - after 5 wrong passwords a login is locked for 30 s, doubling up to 15 min
  - at most one email per address per minute, and five per hour
  - **serve the site over HTTPS**; the forms warn when it isn't
- **Browser sessions:** each browser has a random token. Logging in links its SHA-256 hash to the account, so a reload keeps you logged in.

**Email settings:** `SMTP_HOST`, `SMTP_PORT` (default 587; 465 uses TLS from the start), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (e.g. `Doughnut <no-reply@yourdomain>`), and optionally `SMTP_SECURE=true|false`. `PUBLIC_URL` is the site's address used in links (e.g. `https://doughnut.example.com`). **Without SMTP settings, emails are printed to the server log instead of sent**, which is handy for trying it out. Use the SMTP details from your host's email settings; they usually match what a mail app would use.

With a database configured, all of this is saved. Without one (or if it can't connect at startup; it logs why), accounts work until the server restarts, then are forgotten.

- **Setup:** create an empty database and a user with rights on it. The server creates and upgrades its tables on startup, so there's no migration step. Upgrading from earlier versions:
  - first-version tables (one row per browser, no passwords) are moved aside to `*_v1`
  - nickname + password accounts get email columns and keep working, logging in by nickname (they can't reset a password: no email)

  Works with MySQL 5.7+/8 and MariaDB 10.3+.
- **Tables:**
  - `players`: accounts (email, nickname, scrypt password hash, `verified_at`, OpenSkill `mu`/`sigma`, games, wins)
  - `sessions`: browser token hash → player
  - `email_links`: confirmation and reset link hashes, with expiry and when used
  - `games`: one row per finished game that included at least one account
  - `game_players`: one row per seat, with kind (account/guest/bot), final score, placing, won, left early, rating before and after
- **Ratings:** OpenSkill (Weng-Lin) among the registered players in a game, placed by final score (ties share a place, players who left finish last). A game is rated when it has two or more registered players; guests and bots affect placings but have no rating. The displayed rating is `1000 + 40 × (mu − 3σ)`: a new player starts at 1000, and it rises as the system becomes sure of you.
- **`GET /api/leaderboard?limit=20`** returns the top rated players. The home page shows it, along with your own rating. After a rated game you see your change.

Tests: `TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/testdb npm test` also runs the MySQL tests. **They drop and recreate the tables in that database.**

To deploy, upload `dist/` and `models/` (no `npm install` needed on the host) and set the start file to `dist/server.cjs`. The server must run as **one long-lived process**: games live in memory, and players stay connected over a WebSocket at `/ws`. Things to check with the host:
- **WebSockets** must be allowed through their proxy. Shared hosts that run Node behind Phusion Passenger (common with cPanel's "Setup Node.js App") usually support them, but some plans don't.
- **One instance only:** no clustering or multiple workers, or players at the same table could land on different processes.
- **Idle shutdown:** if the host stops the app when idle, games in progress are lost (players just start a new one).

`GET /health` returns `{ ok, tables, model }`.

What's in it: guests with a nickname, and accounts once they sign up with an email (a random token kept in the browser means a reload rejoins the same seat), private tables (2–6 seats) with a 5-letter code and invite link, quick match (4 seats; bots fill in after 10 s), ratings and a leaderboard (with MySQL), and offline practice that runs the same table code in the browser. AI players get names from a list of funny ones (`src/game/bot-names.ts`), never repeating at a table or copying a human there, and keep them for a rematch. They show a robot icon wherever their name appears. A player who leaves keeps their name, gains the icon, and a bot plays on for them. The table is drawn in SVG: a felt oval inside a stitched leather rail, with players seated around it, you always at the bottom, and each card played landing in front of whoever played it. On narrow screens the oval stands upright. The server is the only authority: each player receives only their own view, and every move is checked by the engine. Bots fill empty seats, play for anyone who misses the 30 s turn timer, and cover disconnected players within 1.5 s until they reconnect. Code: `src/game/` (table, lobby, protocol; no Node dependencies), `src/server/` (HTTP + WebSocket), `src/client/` (plain TypeScript, no framework).

## Commands

```sh
npm install
npm test
npm run serve                                               # build, then serve on http://localhost:3000
npm run play -- --bots ismcts,heuristic,heuristic          # you are seat 0
npm run tournament -- --bots ismcts,heuristic,heuristic,heuristic --games 100
npm run train -- --hands 300000                             # writes models/doughnut.json
npm run gen-data -- --hands 15000 --iterations 1000         # ISMCTS teacher data -> data/
npm run distill -- --data data/doughnut-ismcts.bin          # train the network on it
```

Bots: `random`, `heuristic`, `ismcts`, `ismcts:<iterations>` (default 1500), `dmc:<model.json>`. Modes: `--mode doughnut | doughnut-20`.

## Doughnut rules (as implemented)

- 52 cards, A high. 2–6 players, 5 cards each; the next card is turned up and its suit is trump.
- **Turn-up is a 10 or Ace:** everyone plays. The dealer may swap one card for the turn-up.
- **Otherwise:** clockwise from the dealer's left, each player plays or folds. The dealer decides last: fold, or pick up the turn-up (discarding one card) and play.
- Dealer's left leads (the next active player if they folded). Must follow suit; if void, may play any card, including trump. Highest trump wins, else highest card of the led suit. Trick winner leads next.
- **Scoring:** start at 20. Each trick taken is −1. Playing and taking no tricks is a doughnut, +5. Folding when your score is 5 or less is +1.
- **End:** first to 0 or below (`doughnut`), or lowest after 20 hands (`doughnut-20`).
- **Hand limit:** `doughnut` also stops after 100 hands (lowest wins). With many players, folding is usually free, so games can otherwise stall: with 10 heuristic players more than 10% of games never finished in 2,000 hands (`npx tsx scripts/game-length.ts`).

Interpretations where the rules were silent, all configurable or easy to change:
- If several players reach 0 in the same hand, the lowest score wins; exact ties share the win.
- Scores can go below 0.
- If everyone folds, the hand ends with no tricks (fold penalties still apply).
- The fold penalty uses the score at the start of the hand.
- On a 10/A hand the dealer's exchange is visible to others; the discarded card is not.
- A dealer who picks up may discard the turn-up itself.
- In the `doughnut-20` mode, reaching 0 does not end the game early.

## Adding a mode

A mode is a `GameConfig` object in `modes.ts`. Most variants are a few fields, e.g. `play.mustTrumpIfVoid`, `trump.forcedPlayRanks`, `scoring.noTrickPenalty`, `end.maxHands`. Rules that can't be expressed as settings (e.g. Euchre bowers) are added as named plugins in `rules.ts` and referenced by name from the config.

## AI

- **heuristic**: estimates expected tricks to decide play/fold, then greedy card play. Fast baseline, and the playout policy for ISMCTS.
- **ismcts**: Information-Set Monte Carlo Tree Search. Each iteration deals the hidden cards randomly (consistent with known voids and the dealer holding the turn-up), searches, and plays out the hand. Works for any mode with no extra code. Strength scales with `iterations`.
- **dmc**: a trained network. Deep Monte Carlo (as in DouZero): the network scores each legal move by predicting the reward the hand will end with, then the bot picks the best. One network evaluation per legal move, no search, so it is cheap in the browser.

## Training

`npm run train` runs self-play: worker threads play hands with the latest weights, and the main thread trains on the results. Workers pause when the learner falls behind, so every sample gets trained on.

- **Bounded episodes.** Each training episode is one hand, starting from a randomly sampled scoreboard (scores 1–28, or everyone at 20 for 30% of hands) and a random player count from 2–6. Episodes are short no matter how many players are seated, and the model still sees end-game positions (close to zero, fold penalty active).
- **Reward** is the same as ISMCTS uses: minus the hand's score change divided by 5, plus 1 for a win if the hand ends the game.
- **Opponents:** 25% of seats are played by the heuristic bot, the rest by the model being trained (with random exploration moves, decreasing over training).
- **Encoding** (`features.ts`) describes cards by role: suits are reordered so trump is always first, so one model generalises across suits. The mode's settings are also inputs, so related variants can share a model. Changing the layout means bumping `FEATURE_VERSION` and retraining.
- **Checkpoints:** every evaluation (full games vs heuristic bots) writes `<out>.latest.json`, and `<out>` holds the best so far. `--resume <file>` continues training.

Self-play alone plateaued at ~150k hands (about 50% wins vs three heuristic bots), which is why the distillation step below exists.

Options: `--hands`, `--workers` (default cores − 1; `1` is single-threaded), `--eval-every`, `--eval-games`, `--lr`, `--replay-ratio`, `--seed`, `--mode`.

## Learning from ISMCTS (distillation)

Self-play plateaus because the model can only learn as well as it already plays. Distillation instead trains it on a stronger player's judgement:

1. `npm run gen-data` has ISMCTS play training hands (same bounded single-hand episodes and sampled scoreboards as above; 20% heuristic seats). At every decision it records ISMCTS's value estimate and visit count for **every** legal move, not just the one played, plus the hand's actual outcome. Workers run in parallel and write to `data/*.bin`. Files store the **raw observation** (what the player could see, ~125 bytes per decision), not encoded features, so the encoding can change without re-running the search. This is the slow part: about 4 hands/s on 4 cores at 1,000 iterations.
2. `npm run distill` computes features with the current encoding and trains the network. The default loss (`--loss policy`) has two parts:
   - **policy:** softmax(Q / tau) over the legal moves should match the search's visit distribution. This trains the *differences* between moves, which decide play.
   - **value:** Q should match the search values (for the move played, half search value and half actual outcome). This keeps the scale meaningful.

   `--loss value` uses only the second part. It turned out to be the bottleneck: most of its error goes into how good the position is, which is shared by all moves, so the small gaps between candidate cards were lost. Validation is split by decision. After each epoch it reports validation loss, agreement with the search, and wins against heuristic bots.

Options for `gen-data`: `--hands`, `--iterations`, `--workers`, `--explore` (chance of a visit-weighted random move, default 0.1), `--heuristic-seats`, `--out`. For `distill`: `--data a.bin,b.bin`, `--init <model>` (start from an existing model), `--hidden 512,256` (fresh network size), `--epochs`, `--lr`, `--loss policy|value`, `--tau` (default 0.05; 0.1 was slightly better), `--policy-weight`, `--alpha`, `--min-visits`, `--out`.

Data files can be combined, so more data can be generated later and added. Models record `FEATURE_VERSION` and refuse to load if the encoding has changed (retrain them); data files only need the same `DATA_FORMAT`.

`npx tsx scripts/agreement.ts <test.bin> <model.json>...` compares models against ISMCTS on held-out search data, per decision type: how often they pick the search's top move, and the *regret* (search value given up by not picking it). `npx tsx scripts/search-noise.ts <test.bin>` re-runs ISMCTS on the same positions and scores it the same way, which gives the noise floor: a model at that level matches the search as closely as this measure can tell.

## Results

`models/doughnut.json`: features v2, 250k self-play hands, then distilled with the policy + value loss (tau 0.1, 6 epochs) from 15,000 ISMCTS(1000) hands (184k decisions, ~60 min of generation on 4 cores). Seats rotate in all tournaments.

**Heads-up vs ISMCTS (1500 iterations), 300 games:** dmc 54.5%, ismcts 45.5%. dmc takes 0.2 ms per move, ismcts 29 ms.

**Four players with two heuristic bots, 200 games:** ismcts 41.8%, dmc 36.0% (fair share 25%). This setup barely separates the strong bots; before any distillation it was ismcts 47.9%, dmc 31.3%.

**Policy + value loss vs value-only loss** (same features, data and starting model; 1,500 games each):

| Table | value loss | policy + value loss |
|---|---|---|
| 2 players | 39.9% | **60.1%** |
| 4 players (+2 heuristic) | 33.5% | **41.6%** |
| 6 players (+4 heuristic) | 23.1% | **32.6%** |

**Matching ISMCTS** on 1,000 held-out hands. *Agree* = picks the search's top move; *regret* = search value given up (lower is better). The noise floor is ISMCTS(1000) re-run on the same positions.

| Decision | self-play only | value loss | **policy loss** | noise floor |
|---|---|---|---|---|
| All | 63.5% / 0.0232 | 66.0% / 0.0192 | **78.6% / 0.0083** | 80.9% / 0.0080 |
| Play or fold | 84.6% / 0.0218 | 89.8% / 0.0109 | **95.2% / 0.0038** | 95.7% / 0.0031 |
| Dealer pick up or fold | 56.3% / 0.0340 | 57.4% / 0.0220 | **72.6% / 0.0067** | 68.1% / 0.0106 |
| Card play | 57.2% / 0.0228 | 58.7% / 0.0220 | **73.6% / 0.0100** | 76.7% / 0.0096 |

The network now matches ISMCTS(1000) about as closely as this measure can tell. To get stronger, it needs a stronger teacher: more search iterations, or search that uses the network itself.

What didn't help: a larger network (512-256), and the v2 card-play features (who still has to act, trumps outstanding, safe/wasted winners). With the value loss those features changed nothing; they're kept because the policy-loss model uses them, but they weren't tested separately with it.
