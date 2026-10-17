import { costToCover, type Cost } from "./math.js";
import { aiRate, finalize, FIT_ORDER, overlap } from "./fit.js";
import { normalizeWorld, referenceCandidates } from "./universe.js";
import { rulesParse, understand } from "./worry.js";
import type { Candidate, Fit, Worry } from "./types.js";

export interface PlanInput { worry: string; amountAtRisk: number; maxCost?: number | null; candidates?: unknown[] }
export interface Option {
  market: { source: Candidate["source"]; venue: string; marketId: string; title: string; closeTime: string | null; url: string | null };
  fit: Fit; side: "YES" | "NO"; whatsCovered: string; rulesQuote: string | null; whatsNotCovered: string[]; ratedBy: "ai" | "rules";
  cost: Cost | null; outcomeMint: string | null;
}
export interface Plan {
  verdict: "hedge" | "no_good_hedge"; headline: string; worry: Worry; amountAtRisk: number; maxCost: number | null;
  best: Option | null; alternatives: Option[];
  execute: null | { tool: "world_buy_outcome"; marketId: string; outcomeMint: string | null; side: "YES" | "NO"; amountUsd: number; shares: number; note: string };
  next: string[]; universe: "world" | "reference"; warnings: string[]; disclaimer: string; ms: number;
}

const MAX_JUDGE = 8;
/** Above this all-in price per $1 of payout, the hedge returns too little to be worth recommending. */
export const MAX_PRICE = Number(process.env.HEDGE_MAX_PRICE ?? 0.8);
const usd = (n: number) => `$${n.toFixed(2)}`;

export async function preview(worry: string) {
  const w = await understand(worry);
  return { worry: w, worldSearch: w.searchQueries, next: [
    `Call world_search for each of: ${w.searchQueries.map((q) => JSON.stringify(q)).join(", ")}.`,
    "For the promising hits call world_get_markets (and world_market_prices) to get title, rules, close time, YES/NO mints and asks.",
    "Then call hedge_plan with the worry, amountAtRisk and those markets as candidates." ] };
}

export async function plan(input: PlanInput, now = new Date()): Promise<Plan> {
  const t0 = Date.now(); const warnings: string[] = [];
  const amount = Number(input.amountAtRisk); const maxCost = input.maxCost == null ? null : Number(input.maxCost);
  if (!input.worry?.trim()) throw new Error("worry is required");
  if (!(amount > 0 && amount <= 1_000_000)) throw new Error("amountAtRisk must be between 0 and 1,000,000 (USD)");
  const text = input.worry.trim().slice(0, 600);
  let universe: Plan["universe"] = "world";
  let cs = (input.candidates ?? []).map(normalizeWorld).filter((c): c is Candidate => !!c);
  if ((input.candidates?.length ?? 0) > cs.length) warnings.push(`${(input.candidates?.length ?? 0) - cs.length} candidate(s) skipped: no id or title.`);
  let w: Worry; let raw: Awaited<ReturnType<typeof aiRate>>;
  if (cs.length) {
    // World mode: read the worry and rate the candidates in parallel (one round-trip of latency).
    const quick = rulesParse(text, now);
    cs = cs.map((c) => ({ c, o: overlap(quick, c) })).sort((a, b) => b.o - a.o).slice(0, MAX_JUDGE).map((x) => x.c);
    [w, raw] = await Promise.all([understand(text, now), aiRate(quick, cs, now)]);
  } else {
    w = await understand(text, now);
    universe = "reference"; const r = await referenceCandidates(w.searchQueries.length ? w.searchQueries : [w.subject]); cs = r.candidates; warnings.push(...r.warnings);
    warnings.push("No World markets were supplied, so these are reference markets (Polymarket) for comparison only. They can't be bought through PayBox's World plugin: run world_search with the suggested queries and call hedge_plan again with the results.");
    cs = cs.map((c) => ({ c, o: overlap(w, c) })).sort((a, b) => b.o - a.o).slice(0, MAX_JUDGE).map((x) => x.c);
    raw = await aiRate(w, cs, now);
  }
  const js = finalize(w, cs, raw, now);
  const opts: Option[] = cs.map((c, i) => { const j = js[i]!; const p = j.side === "YES" ? c.yesAsk : c.noAsk; let cost: Cost | null = null;
    if (p !== null && p > 0 && p < 1) cost = costToCover(p, amount, maxCost);
    return { market: { source: c.source, venue: c.venue, marketId: c.marketId, title: c.title, closeTime: c.closeTime, url: c.url }, fit: j.fit, side: j.side,
      whatsCovered: j.covered, rulesQuote: j.quote, whatsNotCovered: j.gaps, ratedBy: j.by, cost, outcomeMint: j.side === "YES" ? c.yesMint : c.noMint }; });
  opts.sort((a, b) => FIT_ORDER[b.fit] - FIT_ORDER[a.fit] || (a.cost ? 0 : 1) - (b.cost ? 0 : 1) || (a.cost?.cost ?? 9e9) - (b.cost?.cost ?? 9e9));
  const top = opts[0] ?? null;
  const reasons: string[] = [];
  if (!top) reasons.push("no markets matched this worry");
  else {
    if (FIT_ORDER[top.fit] < FIT_ORDER.close) reasons.push(`the closest market is only a ${top.fit} fit`);
    if (!top.cost) reasons.push("the matching side has no live price");
    else if (top.cost.price + top.cost.feePerShare >= MAX_PRICE) reasons.push(`it costs ${Math.round((top.cost.price + top.cost.feePerShare) * 100)}¢ per $1 of cover, so it protects almost nothing`);
  }
  const good = !!top && reasons.length === 0;
  const best = good ? top : null;
  let execute: Plan["execute"] = null; const next: string[] = [];
  if (best && best.cost) {
    if (best.market.source === "world") {
      execute = { tool: "world_buy_outcome", marketId: best.market.marketId, outcomeMint: best.outcomeMint, side: best.side, amountUsd: best.cost.cost, shares: best.cost.shares,
        note: `Buy ${best.side} on World for about ${usd(best.cost.cost)} (≈${best.cost.shares} shares at ${Math.round(best.cost.price * 100)}¢ + est. fees). Re-check the price with world_market_prices first; if it moved more than 2¢, call hedge_plan again.` };
      if (!best.outcomeMint) next.push(`The ${best.side} outcome mint wasn't in the candidate data: call world_filter_outcome_mints for market ${best.market.marketId} to get it.`);
      next.push(`Confirm with the user, then call world_buy_outcome with the ${best.side} outcome mint and ${usd(best.cost.cost)}.`);
      next.push(`If the wallet holds less than ${usd(best.cost.cost)} USDC, offer PayBox's get_buy_link (MoonPay) to top up first.`);
    } else next.push(`Best reference match is on ${best.market.venue}. Run world_search ${JSON.stringify(best.market.title)} (and ${w.searchQueries.map((q) => JSON.stringify(q)).join(", ")}) and call hedge_plan again with the World results to get a buyable plan.`);
  } else next.push("Don't buy anything for this worry right now. Tell the user plainly there is no good hedge listed.", ...(universe === "reference" ? [`Optionally search World too: world_search ${w.searchQueries.map((q) => JSON.stringify(q)).join(", ")}`] : []));
  const headline = best && best.cost && best.market.source === "reference"
    ? `Reference match only (not buyable here): YES-equivalent "${best.market.title}" on ${best.market.venue} at ${Math.round(best.cost.price * 100)}¢ (${best.fit} fit). Search World for the same market and re-run with it as a candidate.`.replace("YES-equivalent", best.side)
    : best && best.cost
    ? `${best.fit === "exact" ? "Good" : "Decent"} hedge: buy ${best.side} on "${best.market.title}" for ${usd(best.cost.cost)} → pays ${usd(best.cost.payout)} if it happens (${best.fit} fit).`
    : `No good hedge: ${reasons.join("; ")}.`;
  return { verdict: good ? "hedge" : "no_good_hedge", headline, worry: w, amountAtRisk: amount, maxCost, best, alternatives: opts.filter((o) => o !== best).slice(0, 3),
    execute, next, universe, warnings, disclaimer: "Estimates only. Prices move; fees are estimated (World shows the exact fee at buy). A hedge pays only if the market's rules resolve the way quoted, not whenever you feel the loss.", ms: Date.now() - t0 };
}
