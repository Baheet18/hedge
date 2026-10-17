# Hedge

**Tell it what you're worried about. It finds the prediction market that pays you if it happens, or tells you there isn't one.**

A PayBox plugin and x402 service for the MoonPay PayBox hackathon, Predictions track.

## The problem

Prediction markets work as insurance for real-life risks: a naira devaluation, a hurricane, a recession, a Fed decision. But people don't think in tickers. They think "if the naira passes 2,000 my rent doubles." Getting from that to *which* market, *which side*, *how much*, and *what the fine print actually covers* is slow, and an agent that guesses can buy something that doesn't pay out when the bad thing happens.

## What Hedge returns

For a worry plus the dollar amount at risk:

| | |
|---|---|
| **Market + side** | The World market and the side (usually YES) that pays **if the worry happens** |
| **Price, cost, payout** | Ask price, cost to cover `$C` = `C × (price + fee)`, payout `$C`. With `maxCost`, cover shrinks to fit |
| **What's covered** | A sentence quoted verbatim from the market's rules (checked in code to be in the rules) |
| **What isn't** | Plain gaps: timing, place, threshold, definition, combined conditions |
| **Fit** | `exact` / `close` / `loose` / `none`. Anything below `close`, or costing ≥ 80¢ per $1, gives **"No good hedge"** |
| **Execute** | The exact `world_buy_outcome` call: market id, outcome mint, side, USD amount |

Hedge never buys. The agent runs the buy through PayBox's built-in **World** plugin, and PayBox asks the user to approve it.

## How it works

```mermaid
sequenceDiagram
  participant U as User
  participant A as Agent (PayBox)
  participant H as Hedge plugin
  participant S as Hedge service (Vercel)
  participant W as World plugin (Solana)
  U->>A: "Paid in naira; worried USD/NGN passes 2,000 by Dec. $500 at risk"
  A->>H: hedge_preview(worry) (free)
  H->>S: POST /v1/preview
  S-->>A: parsed event + world_search queries
  A->>W: world_search / world_get_markets / world_market_prices
  W-->>A: candidate markets (rules, asks, YES/NO mints)
  A->>H: hedge_plan(worry, 500, maxCost, candidates)
  H-->>A: x402 proposal (0.10 USDC, Base)
  A->>U: approve 0.10 USDC?
  A->>S: POST /v1/plan (paid by PayBox)
  S-->>A: plan: market, side, cost, covered/not covered, fit, world_buy_outcome args
  A->>U: "Buy YES for $93.60 → pays $500 if it happens. Not covered: ..."
  U->>A: yes
  A->>W: world_buy_outcome(mint, side, amount) (PayBox approval)
```

**AI vs. code.** Gemini does two things only: read the worry (event, threshold, place, deadline, search terms) and rate each candidate's fit and side against its rules. Everything else is plain code: prices, fees, sizing, payout, the rules quote check (an AI quote is kept only if it appears verbatim in the rules), timing and threshold gap checks that can only downgrade a fit, combined-market detection, and the "no good hedge" decision. Without AI, keyword overlap is used and it can never rate a market buyable.

**Market universe = World.** World's market catalog isn't publicly queryable (its API proxy now returns `401 Unauthorized`; `api.world.xyz` returns 403), so the agent supplies candidates from PayBox's World plugin. With no candidates, Hedge searches Polymarket as a **reference only** and says so: it can't be bought through World, and the response includes `world_search` queries to find the equivalent.

## Being honest about fit

- `exact`: same event, threshold, place and window. It pays whenever the worry happens.
- `close`: same event with a small gap (a slightly different date or threshold). The gap is listed.
- `loose`: a proxy or partial cover. **Not recommended**: the verdict is "no good hedge" and the closest option is shown with its gaps.
- `none`: unrelated.

A hedge pays only if the market resolves the way its rules say, not whenever you feel the loss. Fees are estimated (`0.07·p·(1−p)` per share by default); World shows the real fee at buy time.

## Examples (live run, 16 Oct 2026, reference mode)

| Worry | Result |
|---|---|
| US recession in 2026 costs my job ($3,000) | **Exact**: YES "US recession by end of 2026?" at 8¢ → $255.60 covers $3,000 |
| Fed doesn't cut in December, refinance dies ($800) | **Close**: YES "No change in Fed rates after the Dec 2026 meeting" at 21¢ → $177.36 |
| Naira passes 2,000/$ by year end ($500) | **No good hedge**: nearest is an Argentine peso market (wrong currency) |
| Hurricane landfall in Florida before December ($2,000) | **No good hedge**: nearest is a Georgia landfall market (wrong state) |
| Oil above $100 this year ($600) | **No good hedge**: only an October-only market at 85¢ per $1 |
| Government shutdown before November ($1,000) | **No good hedge**: the only market is combined with "Republicans win the House" |
| Rain on my Lagos wedding, Nov 14 ($300) | **No good hedge** |

## API

- `POST /v1/preview` (free): `{ worry }` → parsed worry + `worldSearch` queries
- `POST /v1/plan` (x402, $0.10 USDC on Base): `{ worry, amountAtRisk, maxCost?, candidates? }` → plan
- `GET /health`

World candidate objects are passed as World's tools return them. Hedge reads `id/marketId/ticker`, `title/question`, `rules/rulesPrimary/description`, `closeTime/expirationTime/endDate`, `yesAsk/noAsk` (probability, cents or 6-dp atomic), and `yesMint/noMint` (or World's `accounts` map).

## Run it

```bash
pnpm install --frozen-lockfile
pnpm test                         # 16 offline tests: math, fit / no-hedge, quoting, parsing
GEMINI_API_KEY=... pnpm dev       # http://localhost:8788
GEMINI_API_KEY=... pnpm worries   # 10 real worries end to end
cd plugin && pnpm install --frozen-lockfile && pnpm test   # PayBox validation → dist/plugin.mjs
```

Environment: `GEMINI_API_KEY`; for paid mode `HEDGE_PAY_TO` (Base USDC address) plus `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` (or `X402_FACILITATOR_URL`). Without them the service runs unpaid (`x-hedge-mode: unpaid-dev`). Optional: `HEDGE_PRICE` (default `$0.10`), `HEDGE_FEE_RATE`, `HEDGE_MAX_PRICE` (0.8).

The plugin reads `HEDGE_URL` (default `https://hedge-paybox.vercel.app`). Allow that host in the PayBox portal.
