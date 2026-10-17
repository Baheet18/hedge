# Hedge

**Tell it what you're worried about. It finds the prediction market that pays you if it happens, or tells you there isn't one.**

A PayBox plugin and x402 service for the MoonPay PayBox hackathon, Predictions track.

## The problem

Prediction markets work as insurance for real-life risks: a naira devaluation, a hurricane, a recession, a Fed decision. But people don't think in tickers. They think "if the naira passes 2,000 my rent doubles." Getting from that to *which* market, *which side*, *how much*, and *what the fine print actually covers* is slow, and an agent that guesses can buy something that doesn't pay out when the bad thing happens.

## What Hedge returns

For a worry plus the dollar amount at risk:

| | |
|---|---|
| **Market + side** | The market and side that pays **if the worry happens**, ranked by fit across World and Polymarket |
| **Price, cost, payout** | Ask price, cost to cover `$C` = `C × (price + fee)`, payout `$C`. With `maxCost`, cover shrinks to fit |
| **What's covered** | A sentence quoted verbatim from the market's rules (checked in code to be in the rules) |
| **What isn't** | Plain gaps: timing, place, threshold, definition, combined conditions |
| **Fit** | `exact` / `close` / `loose` / `none`. Anything below `close`, or costing ≥ 70¢ per $1, gives **"No good hedge"**; ≥ 50¢ warns that cover is expensive |
| **Liquidity** | Cover is capped to the size at the ask (`askQty` from `world_orderbook`): "only $X of cover available at this price" |
| **Execute** | Best fit on World: the exact `world_buy_outcome` call (market id, outcome mint, side, USD amount). Best fit on Polymarket: "buy it there" with a link, plus any decent World option as "buyable now through PayBox" |
| **Not a hedge** | Speculation ("put money on the Knicks") is declined: "That's a bet, not a hedge." |

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
  A->>W: world_search, then world_get_events / world_get_markets (rules), world_market_prices, world_orderbook
  W-->>A: candidate markets (rules, asks, size, YES/NO mints)
  A->>H: hedge_plan(worry, 500, maxCost, candidates)
  H-->>A: x402 proposal (0.10 USDC, Base)
  A->>U: approve 0.10 USDC?
  A->>S: POST /v1/plan (paid by PayBox)
  S->>S: also search Polymarket; rank all by fit
  S-->>A: plan: market, side, cost, covered/not covered, fit, world_buy_outcome args (or Polymarket link)
  A->>U: "Buy YES for $93.60 → pays $500 if it happens. Not covered: ..."
  U->>A: yes
  A->>W: world_buy_outcome(mint, side, amount) (PayBox approval)
```

**AI vs. code.** Gemini does two things only: read the worry (event, threshold, place, deadline, search terms) and rate each candidate's fit and side against its rules. Everything else is plain code: prices, fees, sizing, payout, the rules quote check (an AI quote is kept only if it appears verbatim in the rules), timing and threshold gap checks that can only downgrade a fit, combined-market detection, and the "no good hedge" decision. Without AI, keyword overlap is used and it can never rate a market buyable.

**Venue-agnostic.** Every plan ranks World and Polymarket candidates together by fit. World is just where PayBox can buy today. World's catalog isn't publicly queryable (its API proxy returns `401`), so the agent supplies World markets: `world_search` hits carry no rules, so the agent fetches each hit with `world_get_events(ticker)` / `world_get_markets(ticker)` first. World's `{template, tokens}` rules are rendered with their token values, and event-level `settlementSources` (e.g. Chainlink) appear in "what's covered". Polymarket results from all queries are merged, ranked by overlap with the worry and zero-overlap hits are dropped, so "hurricane" doesn't fill up with NHL Carolina Hurricanes markets. Hedge doesn't execute on Polymarket.

**Never charged for a guess.** In paid mode, if Gemini is over quota or times out, `/v1/plan` returns `503` and x402 doesn't settle, so nobody pays for a keyword-only answer.

## Being honest about fit

- `exact`: same event, threshold, place and window. It pays whenever the worry happens.
- `close`: same event with a small gap (a slightly different date or threshold). The gap is listed.
- `loose`: a proxy or partial cover. **Not recommended**: the verdict is "no good hedge" and the closest option is shown with its gaps.
- `none`: unrelated.

A hedge pays only if the market resolves the way its rules say, not whenever you feel the loss. Fees are estimated (`0.07·p·(1−p)` per share by default); World shows the real fee at buy time.

## Examples (live service, 17 Oct 2026)

| Worry | Result |
|---|---|
| "My savings are in Bitcoin. If it crashes below $55k this year I'm wrecked. Cover $100." | **Exact, buyable now**: YES on World `WXBTCYR-26LOW-B55K` "Bitcoin below $55,000 in 2026?" at 12.6¢ → $13.38 pays $100. Quote: *"If the Bitcoin price trades below $55,000 at any time before December 31, 2026 … as reported by the Chainlink BTC/USD data stream, then the market resolves to Yes."* Returns the `world_buy_outcome` call with the YES mint |
| "I'm in Houston Oct 28–Nov 2, $1,200 at risk if a hurricane hits." | **Best protection is on Polymarket**: YES "Hurricane landfall in Texas by Nov 30" at 10¢ → $127.68 covers $1,200, with a link. Gaps: all of Texas, through Nov 30. Not buyable through PayBox |
| "Rain at my outdoor wedding in Lagos on Dec 12." | **No good hedge** (closest: Melbourne rainfall markets) |
| "I think the Knicks will win, put money on it" | **That's a bet, not a hedge.** |
| "If the Fed hikes twice this year my loan gets expensive." vs World "Exactly 2 hikes" | **No good hedge**: a single bucket is partial cover (3+ hikes not covered), rated loose |

The World market in the first row is World-format input shaped like `world_get_events` output (template rules, Chainlink settlement source), since World's catalog isn't public. Run it against live World data with the PayBox World plugin.

## API

- `POST /v1/preview` (free): `{ worry }` → parsed worry + `worldSearch` queries
- `POST /v1/plan` (x402, $0.10 USDC on Base): `{ worry, amountAtRisk, maxCost?, candidates? }` → plan
- `GET /health`

World candidate objects are passed as World's tools return them. Hedge reads `id/marketId/ticker`, `title/question`, `rules/rulesPrimary/description`, `closeTime/expirationTime/endDate`, `yesAsk/noAsk` (probability, cents or 6-dp atomic), and `yesMint/noMint` (or World's `accounts` map).

## Run it

```bash
pnpm install --frozen-lockfile
pnpm test                         # 24 offline tests (Gemini + Polymarket stubbed)
GEMINI_API_KEY=... pnpm dev       # http://localhost:8788
GEMINI_API_KEY=... pnpm worries   # 10 real worries end to end
cd plugin && pnpm install --frozen-lockfile && pnpm test   # PayBox validation → dist/plugin.mjs
```

Environment: `GEMINI_API_KEY`; for paid mode `HEDGE_PAY_TO` (Base USDC address) plus `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` (or `X402_FACILITATOR_URL`). Without them the service runs unpaid (`x-hedge-mode: unpaid-dev`). Optional: `HEDGE_PRICE` (default `$0.10`), `HEDGE_FEE_RATE`, `HEDGE_MAX_PRICE` (0.7).

The plugin reads `HEDGE_URL` (default `https://hedge-paybox.vercel.app`). Allow that host in the PayBox portal.
