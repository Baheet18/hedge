// Orchestration. Venue-agnostic: World (agent-supplied) and Polymarket (searched) candidates are ranked together by fit.
// World is where PayBox can buy today, so only a World pick gets a world_buy_outcome instruction.
import { costToCover, type Cost } from "./math.js";
import { aiRate, finalize, FIT_ORDER, overlap, titleNumbers } from "./fit.js";
import { normalizeWorldAll, referenceCandidates, polymarketDepth } from "./universe.js";
import { understand } from "./worry.js";
import type { Candidate, Fit, Worry } from "./types.js";

export interface PlanInput { worry: string; amountAtRisk: number; maxCost?: number | null; candidates?: unknown[]; skipReference?: boolean }
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
  next: string[]; worldIncluded?: boolean; searched: { world: number; polymarket: number; polymarketQueries?: string[] }; aiDegraded: boolean; warnings: string[]; disclaimer: string; ms: number;
}

const PER_VENUE = 6;
/** Above this all-in price per $1 of payout, the cover returns too little to recommend. */
export const MAX_PRICE = Number(process.env.HEDGE_MAX_PRICE ?? 0.7);
/** At or above this, warn that the market thinks the bad event is likely, so cover is expensive. */
export const EXPENSIVE = 0.5;
/** Prices under 1¢ or over 99¢ are never good cover (stale, near-resolved, or a lottery ticket). */
export const MIN_TICK = 0.01;
/** Budget for the whole request; the AI judge gets what's left (PayBox allows 10s per call). */
const BUDGET_MS = Number(process.env.HEDGE_BUDGET_MS ?? 7000);
const usd = (n: number) => `$${n.toFixed(2)}`;
const cents = (p: number) => `${Math.round(p * 1000) / 10}¢`;

/** Fixed market-style queries for topics Polymarket words its own way (e.g. Fed meetings are "Fed decision in October"). */
export function topicQueries(text: string): string[] {
  if (FED.test(text)) return ["fed decision", "fomc"];
  return [];
}
const FED = /\b(fed|fomc|federal reserve|rate (cut|hike)s?|interest rates?|cut rates|raise rates|powell)\b/i;
/** Close time falls inside the worry's window (now .. deadline + 3 days). */
export function inWindow(w: Worry, close: string | null, now = new Date()): boolean {
  if (!w.deadline || !close) return false; const t = new Date(close).getTime();
  return t >= now.getTime() && t <= new Date(`${w.deadline}T23:59:59Z`).getTime() + 3 * 864e5;
}
/** Month-scoped searches, e.g. "bitcoin october", "ethereum october", plus "<asset> dip" for a fall worry, when the window ends within ~6 weeks. */
export function monthQueries(w: Worry, topic: string, now = new Date()): string[] {
  if (!w.deadline || !topic || FED.test(w.text)) return [];
  const dl = new Date(`${w.deadline}T12:00:00Z`); if (dl.getTime() - now.getTime() > 45 * 864e5 || dl < now) return [];
  const t = topic.toLowerCase() === "btc" ? "bitcoin" : topic.toLowerCase() === "eth" ? "ethereum" : topic.toLowerCase();
  return [`${t} ${MONTH_NAMES[dl.getUTCMonth()]}`, ...(w.direction === "below" ? [`${t} dip`] : [])];
}
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Score bonus so the right Fed meeting/outcome ranks first: next-meeting worries favour the nearest meeting; "no cut"/"hold" worries favour the "no change" outcome. */
export function topicBoost(text: string, c: Candidate, now = new Date()): number {
  if (!FED.test(text)) return 0;
  const t = text.toLowerCase(); const title = c.title.toLowerCase();
  if (!/\bfed\b|fomc|federal reserve|interest rate/.test(title)) return 0;
  if (/dissent|say |mention|hike-|pause-/.test(title)) return 0.05;
  let b = 0.3;
  const named = MONTH_NAMES.find((m) => t.includes(m));
  if (named) { if (title.includes(named)) b += 0.4; }
  else if (/\bnext (fed |fomc )?(meeting|decision)|this (meeting|month)|\bnext\b/.test(t) && c.closeTime) {
    const days = (new Date(c.closeTime).getTime() - now.getTime()) / 864e5; if (days > 0 && days < 50 && /meeting|decision/.test(title)) b += 0.4;
  }
  const noCut = /\b(doesn'?t|does not|don'?t|won'?t|will not|no|fails? to|not) (cut|lower)|\bhold|\bpause|no change|keeps? rates/.test(t);
  if (noCut && /no change/.test(title)) b += 0.3;
  if (/\b(cuts?|lowers?) rates?\b/.test(t) && !noCut && /decrease|cut/.test(title)) b += 0.2;
  return b;
}

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
  if (o.fit === "none") why.push("no listed market pays when this happens");
  if (o.ratedBy !== "ai" && FIT_ORDER[o.fit] < FIT_ORDER.close) why.push("it was matched by keywords only (AI unavailable), so it can't be recommended");
  if (!o.cost) why.push("the matching side has no live price");
  else if (o.cost.price < MIN_TICK) why.push(`it's priced at ${cents(o.cost.price)}, below 1¢, so the market thinks it almost can't happen: it's near-certain not to pay, or the price is stale`);
  else if (o.cost.price > 1 - MIN_TICK) why.push(`it's priced above 99¢, so it's no cover`);
  else if (o.cost.price + o.cost.feePerShare >= MAX_PRICE) why.push(`it costs ${Math.round((o.cost.price + o.cost.feePerShare) * 100)}¢ per $1 of cover, so it protects almost nothing`);
  else if (o.cost.shares <= 0) why.push("no cover is available at this price");
  return why;
}

export let timing: any = null;
export async function plan(input: PlanInput, now = new Date()): Promise<Plan> {
  const t0 = Date.now(); const warnings: string[] = [];
  const amount = Number(input.amountAtRisk); const maxCost = input.maxCost == null ? null : Number(input.maxCost);
  if (!input.worry?.trim()) throw new Error("worry is required");
  if (!(amount > 0 && amount <= 1_000_000)) throw new Error("amountAtRisk must be between 0 and 1,000,000 (USD)");
  const text = input.worry.trim().slice(0, 600);
  const w = await understand(text, now); const tParse = Date.now() - t0;
  const base = { worry: w, amountAtRisk: amount, maxCost, disclaimer: "Estimates only. Prices move; fees are estimated (World shows the exact fee at buy). A hedge pays only if the market's rules resolve the way quoted, not whenever you feel the loss." };
  if (w.isBet) return { ...base, verdict: "not_a_hedge", headline: "That's a bet, not a hedge. What loss are you protecting? If you already bought tickets, have a job, trip or savings that this outcome hurts, tell me the loss and the amount and I'll find cover for that (e.g. \"I booked a non-refundable $300 trip to the Lakers' next-round game, and lose it if they don't advance\").", best: null, buyableNow: null, alternatives: [], execute: null,
    next: ["Don't buy anything. Ask the user what loss they're protecting (tickets already bought, a job, a trip, savings) and how much; then call hedge_match with that worry."], searched: { world: 0, polymarket: 0 }, aiDegraded: w.parsedBy !== "ai", warnings, ms: Date.now() - t0 };

  // Overlap with the worry, plus a bonus for thresholds nearest the user's (so "BTC below 55k" finds the 55k/50k lines among 40+).
  const near = (c: Candidate) => { if (!w.threshold) return 0; const ns = titleNumbers(c.title).filter((n) => n / w.threshold! > 0.2 && n / w.threshold! < 5);
    return ns.length ? Math.max(0, 0.5 - Math.min(...ns.map((n) => Math.abs(n - w.threshold!) / w.threshold!))) : 0; };
  const topical = topicQueries(w.text);
  const inWin = (c: { closeTime: string | null }) => inWindow(w, c.closeTime, now);
  const score = (c: Candidate) => { const o = overlap(w, c) + topicBoost(w.text, c, now); return o > 0 ? o + near(c) + (inWin(c) ? 0.25 : 0) : 0; };
  const worldAll = (input.candidates ?? []).flatMap(normalizeWorldAll);
  if ((input.candidates?.length ?? 0) && !worldAll.length) warnings.push("None of the World candidates had an id and title.");
  if (worldAll.some((c) => !c.rules)) warnings.push("Some World candidates had no rules: call world_get_events / world_get_markets for them, or they can't rate above loose.");
  const world = worldAll.map((c) => ({ c, o: score(c) })).sort((a, b) => b.o - a.o).slice(0, PER_VENUE).map((x) => x.c);
  // Always add a core-event query (first two key terms) so city-level wording still finds region-level markets.
  const core = w.keyTerms.slice(0, 2).join(" ");
  // Polymarket's search matches short topic words best ("bitcoin", "recession"); long phrases with numbers often return nothing.
  const topic = (w.keyTerms.find((k) => k.length > 3 && !/^\d|^(below|above|drops?|falls?|crash|price|lose|loss|job)$/.test(k)) ?? "").trim();
  const monthQ = monthQueries(w, topic, now);
  const queries = [...new Set([...topical, ...monthQ, ...(w.searchQueries.length ? w.searchQueries : [w.subject]).slice(0, 2), ...(core ? [core] : []), ...(topic ? [topic] : [])].map((q) => q.toLowerCase()))].slice(0, 4 + Math.min(1, monthQ.length));
  const poly = input.skipReference ? { candidates: [], warnings: [] as string[] } : await referenceCandidates(queries, score, PER_VENUE, Math.min(2200, Math.max(1200, BUDGET_MS - 2500 - (Date.now() - t0))));
  warnings.push(...poly.warnings);
  if (!input.skipReference) console.log("[hedge] polymarket", JSON.stringify({ queries, hits: poly.candidates.length, top: poly.candidates.slice(0, 3).map((c) => c.title), warnings: poly.warnings }));
  if (!worldAll.length) warnings.push("No World markets were supplied, so nothing here is buyable through PayBox yet. Run world_search with the preview queries and pass the results as candidates.");
  const cs = [...world, ...poly.candidates];
  const tPoly = Date.now() - t0; const raw = await aiRate(w, cs, now, Math.max(1800, BUDGET_MS - 600 - (Date.now() - t0)));
  const js = finalize(w, cs, raw, now); timing = { parse: tParse, poly: tPoly, judge: Date.now() - t0 - tPoly, n: cs.length };
  const opts: Option[] = cs.map((c, i) => {
    const j = js[i]!; const side = j.side; const p = side === "YES" ? c.yesAsk : c.noAsk; const ow: string[] = [];
    const avail = side === "YES" ? c.askQty.yes : c.askQty.no;
    let cost: Cost | null = null;
    if (p !== null && p > 0 && p < 1) {
      cost = costToCover(p, amount, maxCost, avail);
      if (c.source === "world" && avail === null) ow.push("Size not checked: run world_orderbook for this market to confirm the cover is available at this price.");
      if (cost.liquidityCapped) ow.push(`Only ${usd(cost.payout)} of cover is available at this price (${avail} shares at the ask); more would cost more.`);
      if (cost.capped) ow.push(`Your ${usd(maxCost!)} cap buys ${Math.round(cost.coverage * 100)}% of the cover.`);
      if (p < MIN_TICK || p > 1 - MIN_TICK) ow.push(`Priced at ${cents(p)}: outside 1–99¢, so it's not treated as cover.`);
      if (p + cost.feePerShare >= EXPENSIVE) ow.push(`The market thinks this is likely (${cents(p)}), so cover is expensive: ${usd(cost.cost)} to get ${usd(cost.payout)}.`);
    }
    return { market: { source: c.source, venue: c.venue, marketId: c.marketId, title: c.title, closeTime: c.closeTime, url: c.url, settlementSources: c.sources },
      buyableViaPayBox: c.source === "world", fit: j.fit, side, whatsCovered: j.covered, rulesQuote: j.quote, whatsNotCovered: j.gaps, ratedBy: j.by, cost, outcomeMint: side === "YES" ? c.yesMint : c.noMint, warnings: ow };
  });
  // Rank by fit; within a fit level, buyable-now first, then cheaper per $1 of cover.
  const per = (o: Option) => (o.cost ? o.cost.price + o.cost.feePerShare : 9);
  const dist = (o: Option) => { if (!w.threshold) return 0; const ns = titleNumbers(o.market.title).filter((n) => n / w.threshold! > 0.2 && n / w.threshold! < 5);
    return ns.length ? Math.min(...ns.map((n) => Math.abs(n - w.threshold!) / w.threshold!)) : 1; };
  const win = (o: Option) => (inWin(o.market) ? 0 : 1);
  opts.sort((a, b) => FIT_ORDER[b.fit] - FIT_ORDER[a.fit] || win(a) - win(b) || dist(a) - dist(b) || (a.cost ? 0 : 1) - (b.cost ? 0 : 1) || Number(b.buyableViaPayBox) - Number(a.buyableViaPayBox) || per(a) - per(b));
  const good = opts.filter((o) => decide(o).length === 0);
  const best = good[0] ?? null;
  const buyableNow = best && !best.buyableViaPayBox ? good.find((o) => o.buyableViaPayBox) ?? null : best;
  const cap1 = (t: string) => t[0]!.toUpperCase() + t.slice(1);
  const unverified = (o: Option) => o.warnings.some((x) => /^(Size not checked|Depth not checked)/.test(x));
  const share = (o: Option) => unverified(o) ? `up to ${usd(o.cost!.payout)} of cover, size unverified${o.buyableViaPayBox ? " (run world_orderbook to confirm)" : ""}.`
    : `covers ${usd(o.cost!.payout)} of your ${usd(amount)} (${Math.round(o.cost!.payout / amount * 1000) / 10}%).`;
  // Loose fits are shown, but lead with what isn't covered.
  const lead = (o: Option) => o.fit === "loose" ? `Loose fit, read the gaps first: ${o.whatsNotCovered.slice(0, 3).map((g) => g.replace(/\.+$/, "")).join("; ") || "it can fail to pay when your worry happens"}. ` : "";
  // Polymarket depth for the top reference option (one public CLOB call).
  const topRef = good.find((o) => !o.buyableViaPayBox);
  if (topRef?.cost) { const c = cs.find((x) => x.marketId === topRef.market.marketId); const tok = topRef.side === "YES" ? c?.tokenIds?.yes : c?.tokenIds?.no;
    const left = BUDGET_MS + 1500 - (Date.now() - t0); const d = tok && left > 500 ? await polymarketDepth(tok, topRef.cost.price, Math.min(1200, left)) : null;
    if (d === null) topRef.warnings.push("Depth not checked on Polymarket; size at this price may be smaller.");
    else if (d < topRef.cost.shares && d > 0) { topRef.warnings.push(`Polymarket depth: only about ${Math.floor(d)} shares at this price, so ${usd(Math.floor(d))} of cover; more would cost more.`); topRef.cost = costToCover(topRef.cost.price, amount, maxCost, Math.floor(d)); } }
  const aiDegraded = w.parsedBy === "rules" || js.some((j) => j.by !== "ai");

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
    headline = opts[0] && opts[0].fit !== "none" ? `No good hedge: ${decide(opts[0]).join("; ")}.` : "No good hedge: no listed market pays when this happens.";
    if (opts[0] && opts[0].fit !== "none" && opts[0].ratedBy === "ai") headline = `No good hedge: the nearest market ${decide(opts[0]).join("; ")}.`;
    if (!worldAll.length) { headline += ` World wasn't searched yet: run world_search ${JSON.stringify(w.searchQueries[0] ?? w.subject)} and pass the results.`; next.push(`World wasn't searched yet. Call world_search ${JSON.stringify(w.searchQueries[0] ?? w.subject)}, then world_get_events(ticker) for the top 1-2 hits, and pass them as candidates.`); }
    else next.push("Don't buy anything for this worry. Tell the user plainly there is no good hedge listed.");
  } else if (best.buyableViaPayBox) {
    verdict = "hedge";
    headline = `${lead(best)}${best.fit === "exact" ? "Good" : best.fit === "close" ? "Decent" : "Partial"} hedge: buy ${best.side} on World "${best.market.title}" for ${usd(best.cost!.cost)} → pays ${usd(best.cost!.payout)} if it happens (${best.fit} fit). ${cap1(share(best))}`;
    buy(best);
  } else {
    verdict = "hedge_elsewhere";
    headline = `${lead(best)}Best protection is on Polymarket at ${cents(best.cost!.price)}: buy ${best.side} on "${best.market.title}" there (${best.market.url}). ${usd(best.cost!.cost)} ${share(best).replace(/\.$/, "")} (${best.fit} fit).`;
    if (buyableNow) { headline += ` Buyable now through PayBox: ${buyableNow.side} on World "${buyableNow.market.title}" for ${usd(buyableNow.cost!.cost)}, ${share(buyableNow)} (${buyableNow.fit} fit).`; buy(buyableNow); }
    else next.unshift(`Hedge can't buy on Polymarket. Give the user the link (${best.market.url}); nothing on World fits well enough to buy through PayBox.`);
  }
  // Timeframe: if the pick runs well past the worry window while an in-window market exists, say why.
  if (best && w.deadline && !inWin(best.market)) {
    const alt = opts.find((o) => o !== best && o.fit !== "none" && inWin(o.market) && o.cost);
    if (alt) { const why = FIT_ORDER[best.fit] > FIT_ORDER[alt.fit] ? `it fits better (${best.fit} vs ${alt.fit}${dist(alt) > dist(best) ? `; the in-window market triggers at a different level` : ""})` : "the in-window market isn't good cover";
      headline += ` Picked over the cheaper in-window "${alt.market.title}" (${cents(alt.cost!.price)}) because ${why}; that one only pays inside your window, so consider it if the longer cover isn't worth ${best.cost ? cents(best.cost.price) : "the extra"}.`; }
  }
  if (!worldAll.length && !w.isBet && verdict !== "no_good_hedge") { headline += " Note: World markets weren't included in this request, so nothing here is buyable through PayBox. Pass World candidates (world_search → world_get_events) to include them.";
    next.unshift("World markets were NOT included (none were passed as candidates; Hedge can't reach World directly). Call world_search with the worry's query, world_get_events(ticker) for the top hits, and call hedge_plan again with them as candidates."); }
  return { ...base, verdict, headline, best, buyableNow: buyableNow && buyableNow !== best ? buyableNow : null, alternatives: opts.filter((o) => o !== best && o !== buyableNow && o.fit !== "none").slice(0, 3), worldIncluded: worldAll.length > 0,
    execute, next, searched: { world: worldAll.length, polymarket: poly.candidates.length, polymarketQueries: input.skipReference ? [] : queries }, aiDegraded, warnings, ms: Date.now() - t0 };
}

/** Free tier: the best match and what it costs to cover. The paid plan adds sizing detail, the rules quote, gaps, alternatives and the buy instruction. */
export async function freeMatch(input: PlanInput, now = new Date()) {
  // Free tier with World candidates skips the Polymarket search to stay well inside PayBox's 10s call limit.
  const p = await plan({ ...input, skipReference: !!input.candidates?.length }, now);
  const o = p.buyableNow ?? p.best ?? null;
  const show = (x: Option | null) => x && { venue: x.market.venue, marketId: x.market.marketId, title: x.market.title, side: x.side, fit: x.fit, buyableViaPayBox: x.buyableViaPayBox,
    price: x.cost?.price ?? null, costToCover: x.cost?.cost ?? null, payout: x.cost?.payout ?? null, coveragePct: x.cost ? Math.round(x.cost.payout / p.amountAtRisk * 1000) / 10 : null, whatsNotCovered: x.whatsNotCovered, warnings: x.warnings, closeTime: x.market.closeTime, url: x.market.url };
  const noWorld = !(input.candidates?.length);
  const next: string[] = [];
  if (p.verdict === "not_a_hedge") next.push(...p.next);
  else {
    if (noWorld && !p.worry.isBet) next.push(`To find buyable World markets: call world_search once with ${JSON.stringify(p.worry.searchQueries[0] ?? p.worry.subject)}, then world_get_events(ticker) for the top 1-2 event tickers (optionally world_orderbook for size), and pass those results as candidates to hedge_match (free) or straight to hedge_plan.`);
    if (o) next.push(`Show the user this match. For the full plan (exact shares, rules quote, what isn't covered, size available at the ask, alternatives and the world_buy_outcome call), call hedge_plan with the same worry, amountAtRisk and candidates (0.01 USDC).`);
    else if (noWorld) next.push("Nothing outside World fits. Search World as above before telling the user there's no hedge; don't call hedge_plan yet.");
    else next.push("Tell the user plainly there's no good hedge listed for this worry. Don't call hedge_plan unless they supply other markets.");
  }
  return { tier: "free", verdict: p.verdict, headline: p.headline, worry: { summary: p.worry.summary, category: p.worry.category, threshold: p.worry.threshold, deadline: p.worry.deadline, location: p.worry.location },
    amountAtRisk: p.amountAtRisk, match: show(o), closestNotRecommended: !o && !p.aiDegraded && p.alternatives[0] && p.alternatives[0].fit !== "none" ? { ...show(p.alternatives[0]), why: "Only a loose fit or not good value; shown for reference, don't buy it as cover." } : null, polymarketReference: p.best && p.best !== o ? show(p.best) : null,
    worldSearch: noWorld ? p.worry.searchQueries : [], next, searched: p.searched, aiDegraded: p.aiDegraded, disclaimer: p.disclaimer, ms: p.ms, timing };
}
