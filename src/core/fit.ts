// Fit rating. AI reads worry vs. market rules and proposes fit/side/gaps; code verifies quotes and checks timing and thresholds.
import { geminiJson, llmAvailable } from "./llm.js";
import type { Candidate, Fit, FitJudgement, Worry } from "./types.js";

export const FIT_ORDER: Record<Fit, number> = { exact: 3, close: 2, loose: 1, none: 0 };
const DOWN: Record<Fit, Fit> = { exact: "close", close: "loose", loose: "none", none: "none" };
export const down = (f: Fit, n = 1): Fit => (n <= 0 ? f : down(DOWN[f], n - 1));
const DIFF = /\b(closes before|ends before|after your|outside your|shorter|longer window|whole (state|country)|wider|narrower|area|region|statewide|county|city-level|definition|defined as|only (counts|pays|if)|doesn't count|does not count|not count|tropical storm|declar|officially)/i;
const day = (d: Date) => new Date(d.getTime() - 60_000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "America/New_York" }); // markets settle on US Eastern dates
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export const sentences = (t: string) => {
  const raw = t.replace(/\s+/g, " ").split(/(?<=[^\d\s][.!?]|[a-z]{2,}\d[.!?])\s+(?=[A-Z(“"])/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = []; // glue fragments like "...is met: 1." onto the next sentence
  for (const s of raw) { const prev = out[out.length - 1]; if (prev && (prev.length < 40 || /[:;]\s*\d?\.?$/.test(prev))) out[out.length - 1] = `${prev} ${s}`; else out.push(s); }
  return out.filter((s) => s.length > 12);
};
const tokens = (s: string) => new Set(norm(s).replace(/[^a-z0-9$.\s]/g, " ").split(" ").filter((w) => w.length > 2));

const ALIAS: Record<string, string[]> = { naira: ["ngn"], ngn: ["naira"], bitcoin: ["btc"], btc: ["bitcoin"], ethereum: ["eth"], fed: ["federal reserve", "fomc"],
  recession: ["gdp", "nber"], hurricane: ["landfall", "tropical"], election: ["elected", "wins", "president"], inflation: ["cpi"], oil: ["crude", "wti", "brent"] };
export function overlap(w: Worry, c: Candidate): number {
  const terms = [...new Set([...w.keyTerms, ...tokens(w.subject)])].filter((t) => t.length > 2);
  if (!terms.length) return 0;
  const hay = norm(`${c.title} ${c.rules}`).replace(/(\d),(\d{3})/g, "$1$2");
  return terms.filter((t) => hay.includes(t) || (ALIAS[t] ?? []).some((a) => hay.includes(a))).length / terms.length;
}

/** The rules sentence that best states what pays out. Returns verbatim text from the rules, or null. */
export function bestQuote(w: Worry, c: Candidate, hint?: string | null): string | null {
  const ss = sentences(c.rules);
  if (hint) { const h = norm(hint).replace(/^"|"$/g, ""); if (h.length > 12 && norm(c.rules).includes(h)) { const s = ss.find((x) => norm(x).includes(h)); return (s ?? hint).slice(0, 400); } }
  if (!ss.length) return null;
  const tw = [...tokens(`${w.subject} ${w.keyTerms.join(" ")}`)];
  const score = (s: string) => { const n = norm(s); return tw.filter((t) => n.includes(t)).length + (/resolve[sd]? (to )?"?yes|will resolve|if .* then|pays? out/i.test(s) ? 2 : 0); };
  return [...ss].sort((a, b) => score(b) - score(a))[0]!.slice(0, 400);
}

/** Thresholds in the market title, e.g. "above $2,000", "100k". */
export function titleNumbers(s: string): number[] {
  return [...s.matchAll(/\$?(\d[\d,]*(?:\.\d+)?)\s*(k|m|%)?/gi)]
    .filter((m) => !(/^(19|20)\d\d$/.test(m[1]!) && !m[0].startsWith("$") && !m[2])) // a bare 4-digit year
    .map((m) => Number(m[1]!.replace(/,/g, "")) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1)).filter((n) => n > 0);
}

/** Drop AI gaps that are vague or contradict the match (e.g. "different threshold" when the market's threshold equals the user's), and tidy wording. */
export function cleanGaps(w: Worry, c: Candidate, gaps: string[]): string[] {
  const ns = titleNumbers(c.title);
  const sameThreshold = !!w.threshold && ns.some((n) => Math.abs(n - w.threshold!) / w.threshold! < 0.005);
  return gaps.map((g) => g.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim().replace(/^[a-z]/, (x) => x.toUpperCase()))
    .filter((g) => g.length >= 12 && g.length <= 160)
    .filter((g) => !(sameThreshold && /\b(threshold|price level|strike|price target)\b/i.test(g)))
    .filter((g) => !(!w.deadline && !w.windowStart && /\b(extends?|longer|wider) (the )?(time )?window\b|\bthrough the end of\b/i.test(g)))
    .filter((g) => !(!w.deadline && !w.windowStart && !/\b(month|week|year|quarter|season|through|until|by (the )?end)\b/i.test(w.text) && /\b(single|one|a) (day|date)\b.*\b(whole|entire|full) (month|week|year|period)\b/i.test(g)))
    .filter((g) => !(!w.deadline && /\b(closes|ends|expires|resolves) (on|in)\b|\bonly (weeks|days) away\b/i.test(g) && /\btim(e|ing)|clos|date\b/i.test(g)))
    .filter((g) => !/\b(but|however) (it )?(matches|covers|is the same)\b|\bunspecified\b/i.test(g))
    .map((g) => (/[.!?]$/.test(g) ? g : `${g}.`));
}

/** Code checks applied on top of any AI rating. Mutates gaps; returns the adjusted fit. */
export function codeChecks(w: Worry, c: Candidate, j: FitJudgement, now = new Date()): FitJudgement {
  let fit = j.fit; const gaps = j.by === "ai" ? cleanGaps(w, c, j.gaps) : [...j.gaps];
  const close = c.closeTime ? new Date(c.closeTime) : null;
  if (close && close.getTime() < now.getTime()) { gaps.unshift("This market has already closed."); fit = "none"; }
  if (close && close.getTime() >= now.getTime()) {
    const hrs = (close.getTime() - now.getTime()) / 36e5;
    const cap = (g: string) => { gaps.unshift(g); if (FIT_ORDER[fit] > FIT_ORDER.loose) fit = "loose"; };
    if (hrs < 48) cap(`Timing: this market resolves ${close.toISOString().slice(0, 16).replace("T", " ")} UTC, so it only covers the next ${Math.max(1, Math.round(hrs))} hours, not your whole worry.`);
    else if (!w.deadline && hrs < 30 * 24) cap(`Timing: it closes ${day(close)}, only ${hrs < 14 * 24 ? `${Math.max(2, Math.floor(hrs / 24))} days` : "weeks"} away. Your worry has no end date, so anything after that isn't covered.`);
  }
  if (w.deadline && close) {
    const dl = new Date(`${w.deadline}T23:59:59Z`); const days = (close.getTime() - dl.getTime()) / 86400e3;
    if (days < -7) { gaps.unshift(`Timing: cover ends ${day(close)}, before your worry window ends (${day(dl)}). Anything after that isn't covered.`); fit = down(fit); }
    else if (days < -1) gaps.push(`Timing: the market closes ${close.toISOString().slice(0, 10)}, a few days before ${w.deadline}. Check that your event is decided by then.`);
    else if (days > 45) gaps.push(`Timing: the market runs to ${day(close)}, well past your window ending ${day(dl)}. It can pay for an event after your exposure ends, so you are paying for extra time you don't need.`);
  }
  if (w.threshold && (w.direction === "above" || w.direction === "below") && j.side === "YES") {
    const ns = titleNumbers(c.title).filter((n) => n / w.threshold! > 0.2 && n / w.threshold! < 5);
    if (ns.length === 1) { const m = ns[0]!;
      const worse = w.direction === "above" ? m > w.threshold * 1.005 : m < w.threshold * 0.995;
      const better = w.direction === "above" ? m < w.threshold * 0.995 : m > w.threshold * 1.005;
      if (worse) { const far = Math.abs(m - w.threshold) / w.threshold; const $ = /\$/.test(`${c.title} ${w.text}`) ? "$" : "";
        gaps.unshift(`Threshold: it pays from ${$}${m.toLocaleString("en-US")}, not ${$}${w.threshold.toLocaleString("en-US")}. A move between the two isn't covered.`);
        // Nearest available strike: always a loose fit (never dropped to none) when it's within 35% and the market is on-topic.
        if (far <= 0.35 && fit !== "none") fit = FIT_ORDER[fit] > FIT_ORDER.loose && far <= 0.1 ? down(fit) : "loose";
        else fit = down(fit, far > 0.1 ? 2 : 1); }
      if (better && Math.abs(m - w.threshold) / w.threshold > 0.2 && FIT_ORDER[fit] > FIT_ORDER.loose) { fit = "loose"; gaps.unshift(`Threshold: it pays at ${m.toLocaleString("en-US")}, far from your ${w.threshold.toLocaleString("en-US")}. It's a different bet, not cover for your worry.`); }
      else if (better) gaps.push(`Threshold: it pays from ${m.toLocaleString("en-US")}, before your ${w.threshold.toLocaleString("en-US")} level, so it can pay when you haven't lost yet (costs more).`);
    }
  }
  if (/\b(and will|combined outcome|parlay)\b/i.test(`${c.title} ${c.rules.slice(0, 300)}`) && FIT_ORDER[fit] > FIT_ORDER.loose) { fit = "loose"; gaps.unshift("Combined market: it also needs a second, unrelated event to happen before it pays."); }
  if (!/\b(exactly|between)\b/i.test(w.text) && /\bexactly\b|\bbetween\b[^?.]*\band\b|\d\s*[-–]\s*\$?\d/i.test(c.title)) {
    if (FIT_ORDER[fit] > FIT_ORDER.loose) fit = "loose"; gaps.unshift("Partial cover: it pays only if the result lands in this one bucket. Results outside this bucket aren't covered unless you buy every bucket.");
  }
  // AI said exact but listed a timing/place/definition gap: that's not exact.
  if (fit === "exact" && j.gaps.some((g) => DIFF.test(g))) fit = "close";
  // Publication lag: settles on data published after the worry window.
  if (/\b(gdp|nber|bureau of economic analysis|bls|advance estimate|initial release|first estimate|published|data release|announced by)\b/i.test(c.rules) && close) {
    const ref = w.deadline ? new Date(`${w.deadline}T23:59:59Z`) : now;
    if (close.getTime() - ref.getTime() > 30 * 864e5 || /\b(q4|fourth quarter)\b/i.test(`${c.title} ${c.rules}`))
      gaps.push(`Publication lag: it settles on official data published later (market closes ${day(close)}), so even if it happens you may wait months to be paid.`);
  }
  // Trip/window worries: a market open before the user's window pays for events they aren't exposed to.
  if (w.windowStart && close) { const ws = new Date(`${w.windowStart}T00:00:00Z`);
    if (ws.getTime() - now.getTime() > 2 * 864e5) gaps.push(`Timing: it also pays for an event between now and ${day(ws)}, before your window starts, when you aren't exposed; you pay for that time too.`); }
  if (!w.deadline && close && close.getTime() > now.getTime() && !gaps.some((g) => /^Timing:/.test(g))) gaps.push(`Cover ends ${day(close)}; anything after that isn't covered.`);
  // Personal loss (job, income, sales) vs a macro market: the macro event can happen without your loss, and vice versa.
  if (/\b(my job|lose (my )?job|laid off|layoff|fired|my (income|salary|sales|business|customers))\b/i.test(w.text) && /\b(recession|gdp|unemployment rate|nber|jobs report|payrolls)\b/i.test(`${c.title} ${c.rules.slice(0, 400)}`) && FIT_ORDER[fit] > FIT_ORDER.loose) {
    fit = "loose"; gaps.unshift("Proxy: this pays on a macro event, not on you losing your job. A recession can happen while you keep your job, and you can lose it without one.");
  }
  // Any listed gap caps the fit at close.
  if (fit === "exact" && gaps.length) fit = "close";
  // Never empty: an exact fit still only pays on the market's trigger definition.
  if (fit !== "none" && (fit === "exact" || !gaps.length)) gaps.push(...definitionGaps(w, c));
  if ((j.side === "YES" ? c.yesAsk : c.noAsk) === null) gaps.push("No live price for this side, so it can't be costed.");
  return { ...j, fit, gaps: [...new Set(gaps)].slice(0, 6) };
}

/** Trigger-definition gaps read from the market's own rules (what the market counts), so "not covered" is never empty. */
export function definitionGaps(w: Worry, c: Candidate): string[] {
  const r = `${c.title} ${c.rules}`.toLowerCase(); const out: string[] = [];
  if (/landfall/.test(r)) {
    const st = (/\b(texas|florida|louisiana|georgia|carolina|alabama|mississippi)\b/.exec(c.title.toLowerCase()) ?? [])[1];
    const nb = st === "texas" ? " a Louisiana landfall" : " a landfall elsewhere";
    out.push(`Definition: pays only on a hurricane landfall${st ? ` in ${st[0]!.toUpperCase()}${st.slice(1)}` : ""}; a tropical storm, a near miss, or flooding from${nb} won't pay.`);
  } else if (/\b(hurricane|tropical|cyclone|storm)\b/.test(r)) out.push("Definition: pays only on the storm category and area the rules name; weaker storms, near misses and flood damage alone won't pay.");
  else if (w.threshold && /\b(price|trades?|candle|close[sd]?|settle)\b/.test(r)) out.push(`Definition: pays only if ${c.sources[0] ?? "the market's named price source"} shows the move as the rules define it; a move on your own exchange alone won't count.`);
  if (!out.length) out.push(`Definition: pays only if the event happens exactly as the market's rules word it${c.sources.length ? `, as reported by ${c.sources[0]}` : ""}; a loss that doesn't meet that wording won't pay.`);
  return out;
}

const SCHEMA = { type: "OBJECT", properties: { ratings: { type: "ARRAY", items: { type: "OBJECT", properties: {
  index: { type: "INTEGER" }, fit: { type: "STRING", enum: ["exact", "close", "loose", "none"] }, side: { type: "STRING", enum: ["YES", "NO"] },
  covered: { type: "STRING" }, quote: { type: "STRING", nullable: true }, gaps: { type: "ARRAY", items: { type: "STRING" } } }, required: ["index", "fit", "side", "covered", "gaps"] } } }, required: ["ratings"] };
const SYSTEM = `You judge whether a prediction market is a hedge for a person's worry: does buying one side pay out when the bad thing happens to them?
The worry is the BAD outcome for the user. For each market: side = the side (YES or NO) that pays when the bad outcome happens. Watch negations: if the worry is "the Fed does NOT cut", a "Will the Fed cut?" market hedges on NO, and a "no change" market hedges on YES. fit:
- exact: same event AND same threshold, place, time window and definition; the payout happens whenever the worry happens. If any of timing, place or definition differ, it is NOT exact: drop one grade per difference.
- close: same event, but a small gap (a slightly different threshold or date). A market whose area or time window is WIDER than the worry but still pays whenever the worry happens (e.g. "hurricane landfall anywhere in Texas by Nov 30" for "a hurricane hits Houston Oct 28–Nov 2") is close: it costs more but still covers. NARROWER than the worry (smaller area, shorter window, higher bar) is loose.
- loose: related or correlated (a proxy), but it can easily fail to pay when the worry happens. A combined/parlay market that also needs an unrelated event is loose at best. A market that pays on only a slice of the bad outcome (e.g. "hike 50+ bps" when the worry is "no cut", which mostly means a hold) is loose; prefer the market (or NO side) that covers the whole bad outcome.
- none: unrelated, or it does not pay when the worry happens. Exception: the same event in the same direction at a FARTHER threshold (e.g. "oil above $115" for a worry about oil above $100) is loose, not none: it is the nearest available strike. A different place (e.g. a China cyclone for a Texas hurricane) or a single-minute/single-day price snapshot for a month-long worry is none.
A city/trip worry vs a state-wide season-long market is close at best; if the market's definition excludes part of the worry (e.g. hurricanes only, so a tropical storm doesn't count) drop another grade. A personal loss (job loss, lower sales) vs a macro market (recession, GDP) is loose: the macro event can happen without the loss and vice versa. Be strict. A correlated proxy is "loose" at best. covered: one plain sentence on when it pays, in the user's terms.
quote: copy ONE sentence verbatim from the market rules that defines the payout (or null). gaps: up to 3 things NOT covered, each ONE short plain sentence (max 15 words) a non-expert understands, stating a real difference between the worry and the market, e.g. "Settles on Binance's BTC/USDT price, not your exchange's." Never list something that matches the worry (if the threshold, place or date is the same, don't mention it). No parentheses, no hedging words like 'but', no prices. Return [] if nothing is missing.`;

/** AI ratings (null if AI unavailable). Uses the raw worry text, so it can run in parallel with understand(). */
const judgeCache = new Map<string, { at: number; r: FitJudgement[] }>();
export async function aiRate(w: Worry, cs: Candidate[], now = new Date(), timeoutMs = 12000): Promise<FitJudgement[] | null> {
  if (!llmAvailable() || !cs.length) return null;
  // Same worry + same markets within 15 minutes: reuse the ratings (prices are re-read live each time; only the fit judgement is cached).
  const key = `${w.text.toLowerCase().replace(/\s+/g, " ").trim()}|${cs.map((c) => c.marketId).join(",")}`; const hit = judgeCache.get(key);
  if (hit && process.env.HEDGE_NO_CACHE !== "1" && Date.now() - hit.at < 15 * 6e4) return hit.r;
  const r = await aiRateUncached(w, cs, now, timeoutMs);
  if (r) { if (judgeCache.size > 500) judgeCache.clear(); judgeCache.set(key, { at: Date.now(), r }); }
  return r;
}
async function aiRateUncached(w: Worry, cs: Candidate[], now: Date, timeoutMs: number): Promise<FitJudgement[] | null> {
  try {
    const list = cs.map((c, i) => `#${i} [${c.venue}] ${c.title}\ncloses: ${c.closeTime ?? "unknown"}${c.sources.length ? `\nsettlement source: ${c.sources.join(", ")}` : ""}\nrules: ${c.rules.slice(0, 700) || "(none given)"}`).join("\n\n");
    const o = await geminiJson<{ ratings: Array<{ index: number; fit: Fit; side: "YES" | "NO"; covered: string; quote?: string | null; gaps: string[] }> }>("judge", SYSTEM,
      `Today: ${now.toISOString().slice(0, 10)}\nWorry: ${JSON.stringify(w.text)}${w.parsedBy !== "rules" ? `\nParsed: ${JSON.stringify({ summary: w.summary, direction: w.direction, threshold: w.threshold, unit: w.unit, location: w.location, windowStart: w.windowStart, deadline: w.deadline })}` : ""}\n\nMarkets:\n${list}`,
      SCHEMA, timeoutMs, process.env.HEDGE_JUDGE_THINKING || "minimal");
    return cs.map((c, i) => { const r = o.ratings.find((x) => x.index === i);
      return r ? { marketId: c.marketId, fit: r.fit, side: r.side, covered: r.covered, gaps: (r.gaps ?? []).slice(0, 4), quote: r.quote ?? null, by: "ai" as const }
        : { marketId: c.marketId, fit: "none" as Fit, side: "YES" as const, covered: "", gaps: ["Not rated."], quote: null, by: "ai" as const }; });
  } catch (e) { console.error("[hedge] AI judge fallback:", (e as Error).message); return null; }
}
/** Combine AI ratings (or keyword fallback) with the code checks and verified quotes. */
export function finalize(w: Worry, cs: Candidate[], raw: FitJudgement[] | null, now = new Date()): FitJudgement[] {
  const base = raw ?? cs.map((c) => { const o = overlap(w, c); const fit: Fit = o >= 0.4 ? "loose" : "none"; // keyword overlap alone never earns a buyable rating
    return { marketId: c.marketId, fit, side: "YES" as const, covered: `Pays if the market's YES outcome happens: ${c.title}`, gaps: ["Rated by keyword overlap only (AI unavailable); read the rules before buying."], quote: null, by: "rules" as const }; });
  return base.map((j, i) => { const c = cs[i]!; const k = codeChecks(w, c, j, now);
    const covered = c.sources.length && !/settle|source/i.test(k.covered) ? `${k.covered.replace(/\.?$/, ".")} Settled using ${c.sources.join(", ")}.` : k.covered;
    return { ...k, covered, quote: bestQuote(w, c, j.quote) }; });
}
export async function judge(w: Worry, cs: Candidate[], now = new Date()) { return finalize(w, cs, await aiRate(w, cs, now), now); }
