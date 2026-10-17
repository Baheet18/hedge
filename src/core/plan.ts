// Orchestration. Venue-agnostic: World (agent-supplied) and Polymarket (searched) candidates are ranked together by fit.
// World is where PayBox can buy today, so only a World pick gets a world_buy_outcome instruction.
import { costToCover, type Cost } from "./math.js";
import { aiRate, finalize, FIT_ORDER, overlap } from "./fit.js";
import { normalizeWorldAll, referenceCandidates } from "./universe.js";
import { understand } from "./worry.js";
import type { Candidate, Fit, Worry } from "./types.js";

export interface PlanInput { worry: string; amountAtRisk: number; maxCost?: number | null; candidates?: unknown[] }
export interface Option {
  market: { source: Candidate["source"]; venue: string; marketId: string; title: string; closeTime: string | null; url: string | null; settlementSources: string[] };
  buyableViaPayBox: boolean;
  fit: Fit; side: "YES" | "NO"; whatsCovered: string; rulesQuote: string | null; whatsNotCovered: string[]; ratedBy: "ai" | "rules";
  cost: Cost | null; outcomeMint: string | null; warnings: string[];
}
export type Verdict = "hedge" | "hedge_elsewhere" | "no_good_hedge" | "not_a_hedge";
export interface Plan {
  verdict: Verdict; headline: string; worry: Worry; amountAtRisk: number; maxCost: number | null;
  best: Option | null; buyableNow: Option | null; alternatives: Option[];
  execute: null | { tool: "world_buy_outcome"; marketId: string; outcomeMint: string | null; side: "YES" | "NO"; amountUsd: number; shares: number; note: string };
  next: string[]; searched: { world: number; polymarket: number }; aiDegraded: boolean; warnings: string[]; disclaimer: string; ms: number;
}

const PER_VENUE = 6;
/** Above this all-in price per $1 of payout, the cover returns too little to recommend. */
export const MAX_PRICE = Number(process.env.HEDGE_MAX_PRICE ?? 0.7);
/** At or above this, warn that the market thinks the bad event is likely, so cover is expensive. */
export const EXPENSIVE = 0.5;
const usd = (n: number) => `$${n.toFixed(2)}`;
const cents = (p: number) => `${Math.round(p * 1000) / 10}¢`;

export async function preview(worry: string) {
  const w = await understand(worry);
  if (w.isBet) return { worry: w, worldSearch: [], next: ["That's a bet, not a hedge. Hedge only finds cover for a loss the user would suffer; don't run hedge_plan for this."] };
  return { worry: w, worldSearch: w.searchQueries, next: [
    `Call world_search for each of: ${w.searchQueries.map((q) => JSON.stringify(q)).join(", ")}.`,
    "Search results have no rules. For each promising hit, call world_get_events(ticker) or world_get_markets(ticker) to get the rules (rulesPrimary/rulesSecondary), settlement sources, close time and YES/NO mints, plus world_market_prices for asks. Optionally world_orderbook for the size available at the ask (askQty).",
    "Then call hedge_plan with the worry, amountAtRisk and those market (or event) objects as candidates. Hedge also checks Polymarket itself." ] };
}

function decide(o: Option): string[] {
  const why: string[] = [];
  if (FIT_ORDER[o.fit] < FIT_ORDER.close) why.push(`the closest market is only a ${o.fit} fit`);
  if (!o.cost) why.push("the matching side has no live price");
  else if (o.cost.price + o.cost.feePerShare >= MAX_PRICE) why.push(`it costs ${Math.round((o.cost.price + o.cost.feePerShare) * 100)}¢ per $1 of cover, so it protects almost nothing`);
  else if (o.cost.shares <= 0) why.push("no cover is available at this price");
  return why;
}

export async function plan(input: PlanInput, now = new Date()): Promise<Plan> {
  const t0 = Date.now(); const warnings: string[] = [];
  const amount = Number(input.amountAtRisk); const maxCost = input.maxCost == null ? null : Number(input.maxCost);
  if (!input.worry?.trim()) throw new Error("worry is required");
  if (!(amount > 0 && amount <= 1_000_000)) throw new Error("amountAtRisk must be between 0 and 1,000,000 (USD)");
  const text = input.worry.trim().slice(0, 600);
  const w = await understand(text, now);
  const base = { worry: w, amountAtRisk: amount, maxCost, disclaimer: "Estimates only. Prices move; fees are estimated (World shows the exact fee at buy). A hedge pays only if the market's rules resolve the way quoted, not whenever you feel the loss." };
  if (w.isBet) return { ...base, verdict: "not_a_hedge", headline: "That's a bet, not a hedge. Hedge finds cover for a loss you'd suffer; it doesn't pick winners.", best: null, buyableNow: null, alternatives: [], execute: null,
    next: ["Don't buy anything through Hedge for this. If the user wants to bet, that's their call outside Hedge."], searched: { world: 0, polymarket: 0 }, aiDegraded: w.parsedBy !== "ai", warnings, ms: Date.now() - t0 };

  const score = (c: Candidate) => overlap(w, c);
  const worldAll = (input.candidates ?? []).flatMap(normalizeWorldAll);
  if ((input.candidates?.length ?? 0) && !worldAll.length) warnings.push("None of the World candidates had an id and title.");
  if (worldAll.some((c) => !c.rules)) warnings.push("Some World candidates had no rules: call world_get_events / world_get_markets for them, or they can't rate above loose.");
  const world = worldAll.map((c) => ({ c, o: score(c) })).sort((a, b) => b.o - a.o).slice(0, PER_VENUE).map((x) => x.c);
  const poly = await referenceCandidates(w.searchQueries.length ? w.searchQueries : [w.subject], score, PER_VENUE);
  warnings.push(...poly.warnings);
  if (!worldAll.length) warnings.push("No World markets were supplied, so nothing here is buyable through PayBox yet. Run world_search with the preview queries and pass the results as candidates.");
  const cs = [...world, ...poly.candidates];
  const raw = await aiRate(w, cs, now);
  const js = finalize(w, cs, raw, now);
  const opts: Option[] = cs.map((c, i) => {
    const j = js[i]!; const side = j.side; const p = side === "YES" ? c.yesAsk : c.noAsk; const ow: string[] = [];
    const avail = side === "YES" ? c.askQty.yes : c.askQty.no;
    let cost: Cost | null = null;
    if (p !== null && p > 0 && p < 1) {
      cost = costToCover(p, amount, maxCost, avail);
      if (cost.liquidityCapped) ow.push(`Only ${usd(cost.payout)} of cover is available at this price (${avail} shares at the ask); more would cost more.`);
      if (cost.capped) ow.push(`Your ${usd(maxCost!)} cap buys ${Math.round(cost.coverage * 100)}% of the cover.`);
      if (p + cost.feePerShare >= EXPENSIVE) ow.push(`The market thinks this is likely (${cents(p)}), so cover is expensive: ${usd(cost.cost)} to get ${usd(cost.payout)}.`);
    }
    return { market: { source: c.source, venue: c.venue, marketId: c.marketId, title: c.title, closeTime: c.closeTime, url: c.url, settlementSources: c.sources },
      buyableViaPayBox: c.source === "world", fit: j.fit, side, whatsCovered: j.covered, rulesQuote: j.quote, whatsNotCovered: j.gaps, ratedBy: j.by, cost, outcomeMint: side === "YES" ? c.yesMint : c.noMint, warnings: ow };
  });
  // Rank by fit; within a fit level, buyable-now first, then cheaper per $1 of cover.
  const per = (o: Option) => (o.cost ? o.cost.price + o.cost.feePerShare : 9);
  opts.sort((a, b) => FIT_ORDER[b.fit] - FIT_ORDER[a.fit] || (a.cost ? 0 : 1) - (b.cost ? 0 : 1) || Number(b.buyableViaPayBox) - Number(a.buyableViaPayBox) || per(a) - per(b));
  const good = opts.filter((o) => decide(o).length === 0);
  const best = good[0] ?? null;
  const buyableNow = best && !best.buyableViaPayBox ? good.find((o) => o.buyableViaPayBox) ?? null : best;
  const aiDegraded = w.parsedBy !== "ai" || js.some((j) => j.by !== "ai");

  let verdict: Verdict; let headline: string; const next: string[] = []; let execute: Plan["execute"] = null;
  const buy = (o: Option) => {
    execute = { tool: "world_buy_outcome", marketId: o.market.marketId, outcomeMint: o.outcomeMint, side: o.side, amountUsd: o.cost!.cost, shares: o.cost!.shares,
      note: `Buy ${o.side} on World for about ${usd(o.cost!.cost)} (≈${o.cost!.shares} shares at ${cents(o.cost!.price)} + est. fees). Re-check with world_market_prices first; if it moved more than 2¢, call hedge_plan again.` };
    if (!o.outcomeMint) next.push(`The ${o.side} outcome mint wasn't in the candidate data: call world_filter_outcome_mints for ${o.market.marketId} to get it.`);
    next.push(`Confirm with the user, then call world_buy_outcome with the ${o.side} outcome mint and ${usd(o.cost!.cost)}.`,
      `If the wallet holds less than ${usd(o.cost!.cost)} USDC, offer PayBox's get_buy_link (MoonPay) to top up first.`);
  };
  if (!best) {
    verdict = "no_good_hedge";
    headline = `No good hedge: ${opts[0] ? decide(opts[0]).join("; ") : "no markets matched this worry"}.`;
    next.push("Don't buy anything for this worry. Tell the user plainly there is no good hedge listed.");
  } else if (best.buyableViaPayBox) {
    verdict = "hedge";
    headline = `${best.fit === "exact" ? "Good" : "Decent"} hedge: buy ${best.side} on World "${best.market.title}" for ${usd(best.cost!.cost)} → pays ${usd(best.cost!.payout)} if it happens (${best.fit} fit).`;
    buy(best);
  } else {
    verdict = "hedge_elsewhere";
    headline = `Best protection is on Polymarket at ${cents(best.cost!.price)}: buy ${best.side} on "${best.market.title}" there (${best.market.url}). ${usd(best.cost!.cost)} covers ${usd(best.cost!.payout)} (${best.fit} fit).`;
    if (buyableNow) { headline += ` Buyable now through PayBox: ${buyableNow.side} on World "${buyableNow.market.title}" for ${usd(buyableNow.cost!.cost)} (${buyableNow.fit} fit).`; buy(buyableNow); }
    else next.unshift(`Hedge can't buy on Polymarket. Give the user the link (${best.market.url}); nothing on World fits well enough to buy through PayBox.`);
  }
  return { ...base, verdict, headline, best, buyableNow: buyableNow && buyableNow !== best ? buyableNow : null, alternatives: opts.filter((o) => o !== best && o !== buyableNow).slice(0, 3),
    execute, next, searched: { world: worldAll.length, polymarket: poly.candidates.length }, aiDegraded, warnings, ms: Date.now() - t0 };
}
