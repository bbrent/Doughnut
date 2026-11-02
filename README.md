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
  train*.ts       training loop (single-threaded and worker threads)
src/runner.ts play a full game with one agent per seat
src/cli/      tournament, terminal play, training
scripts/      one-off analysis (game length, profiling)
```

Agents only receive an `Observation` (their own hand + public info), never the full state, so no bot can cheat.

## Commands

```sh
npm install
npm test
npm run play -- --bots ismcts,heuristic,heuristic          # you are seat 0
npm run tournament -- --bots ismcts,heuristic,heuristic,heuristic --games 100
npm run train -- --hands 300000                             # writes models/doughnut.json
```

Bots: `random`, `heuristic`, `ismcts`, `ismcts:<iterations>` (default 1500), `dmc:<model.json>`. Modes: `--mode doughnut | doughnut-20`.

## Doughnut rules (as implemented)

- 52 cards, A high. 2–10 players, 5 cards each; the next card is turned up and its suit is trump.
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

- **Bounded episodes.** Each training episode is one hand, starting from a randomly sampled scoreboard (scores 1–28, or everyone at 20 for 30% of hands) and a random player count from 2–10. Episodes are short no matter how many players are seated, and the model still sees end-game positions (close to zero, fold penalty active).
- **Reward** is the same as ISMCTS uses: minus the hand's score change divided by 5, plus 1 for a win if the hand ends the game.
- **Opponents:** 25% of seats are played by the heuristic bot, the rest by the model being trained (with random exploration moves, decreasing over training).
- **Encoding** (`features.ts`) describes cards by role: suits are reordered so trump is always first, so one model generalises across suits. The mode's settings are also inputs, so related variants can share a model. Changing the layout means bumping `FEATURE_VERSION` and retraining.
- **Checkpoints:** every evaluation (full games vs heuristic bots) writes `<out>.latest.json`, and `<out>` holds the best so far. `--resume <file>` continues training.

### Results so far

`models/doughnut.json`: 275k training hands (about 20 minutes on 4 cores). 120 four-player games, seats rotating:

| Bot | Win % (fair 25%) | ms / move |
|---|---|---|
| dmc | 31.3% | 0.1 |
| ismcts (1500 iterations) | 47.9% | 25.6 |
| heuristic | 5.4% / 15.4% | 0.0 |

Against three heuristic bots the model wins ~50%. It plateaued after ~150k hands, so more self-play alone won't close the gap to ISMCTS.

Options: `--hands`, `--workers` (default cores − 1; `1` is single-threaded), `--eval-every`, `--eval-games`, `--lr`, `--replay-ratio`, `--seed`, `--mode`.
