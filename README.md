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
src/runner.ts play a full game with one agent per seat
src/cli/      tournament + terminal play
```

Agents only receive an `Observation` (their own hand + public info), never the full state, so no bot can cheat.

## Commands

```sh
npm install
npm test
npm run play -- --bots ismcts,heuristic,heuristic          # you are seat 0
npm run tournament -- --bots ismcts,heuristic,heuristic,heuristic --games 100
```

Bots: `random`, `heuristic`, `ismcts`, `ismcts:<iterations>` (default 1500). Modes: `--mode doughnut | doughnut-20`.

## Doughnut rules (as implemented)

- 52 cards, A high. 2–10 players, 5 cards each; the next card is turned up and its suit is trump.
- **Turn-up is a 10 or Ace:** everyone plays. The dealer may swap one card for the turn-up.
- **Otherwise:** clockwise from the dealer's left, each player plays or folds. The dealer decides last: fold, or pick up the turn-up (discarding one card) and play.
- Dealer's left leads (the next active player if they folded). Must follow suit; if void, may play any card, including trump. Highest trump wins, else highest card of the led suit. Trick winner leads next.
- **Scoring:** start at 20. Each trick taken is −1. Playing and taking no tricks is a doughnut, +5. Folding when your score is 5 or less is +1.
- **End:** first to 0 or below (`doughnut`), or lowest after 20 hands (`doughnut-20`).

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

Next step: self-play reinforcement learning (Deep Monte Carlo, TensorFlow.js), with ISMCTS as the benchmark to beat.
