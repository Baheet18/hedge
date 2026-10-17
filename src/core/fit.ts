// Fit rating. AI reads worry vs. market rules and proposes fit/side/gaps; code verifies quotes and checks timing and thresholds.
import { geminiJson, llmAvailable } from "./llm.js";
import type { Candidate, Fit, FitJudgement, Worry } from "./types.js";

export const FIT_ORDER: Record<Fit, number> = { exact: 3, close: 2, loose: 1, none: 0 };
const DOWN: Record<Fit, Fit> = { exact: "close", close: "loose", loose: "none", none: "none" };
export const down = (f: Fit, n = 1): Fit => (n <= 0 ? f : down(DOWN[f], n - 1));
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

/** Code checks applied on top of any AI rating. Mutates gaps; returns the adjusted fit. */
export function codeChecks(w: Worry, c: Candidate, j: FitJudgement, now = new Date()): FitJudgement {
  let fit = j.fit; const gaps = [...j.gaps];
  const close = c.closeTime ? new Date(c.closeTime) : null;
  if (close && close.getTime() < now.getTime()) { gaps.unshift("This market has already closed."); fit = "none"; }
  if (w.deadline && close) {
    const dl = new Date(`${w.deadline}T23:59:59Z`); const days = (close.getTime() - dl.getTime()) / 86400e3;
    if (days < -7) { gaps.unshift(`Timing: the market closes ${close.toISOString().slice(0, 10)}, before your worry window ends (${w.deadline}). Anything after that isn't covered.`); fit = down(fit); }
    else if (days < -1) gaps.push(`Timing: the market closes ${close.toISOString().slice(0, 10)}, a few days before ${w.deadline}. Check that your event is decided by then.`);
    else if (days > 45) gaps.push(`Timing: the market runs to ${close.toISOString().slice(0, 10)}, well past your ${w.deadline} window. It can pay for an event after your exposure ends, so you are paying for extra time you don't need.`);
  }
  if (w.threshold && (w.direction === "above" || w.direction === "below") && j.side === "YES") {
    const ns = titleNumbers(c.title).filter((n) => n / w.threshold! > 0.2 && n / w.threshold! < 5);
    if (ns.length === 1) { const m = ns[0]!;
      const worse = w.direction === "above" ? m > w.threshold * 1.005 : m < w.threshold * 0.995;
      const better = w.direction === "above" ? m < w.threshold * 0.995 : m > w.threshold * 1.005;
      if (worse) { gaps.unshift(`Threshold: it pays only past ${m.toLocaleString("en-US")}, but your worry starts at ${w.threshold.toLocaleString("en-US")}. A move between the two isn't covered.`); fit = down(fit, Math.abs(m - w.threshold) / w.threshold > 0.1 ? 2 : 1); }
      if (better) gaps.push(`Threshold: it pays from ${m.toLocaleString("en-US")}, before your ${w.threshold.toLocaleString("en-US")} level, so it can pay when you haven't lost yet (costs more).`);
    }
  }
  if (/\b(and will|combined outcome|parlay)\b/i.test(`${c.title} ${c.rules.slice(0, 300)}`) && FIT_ORDER[fit] > FIT_ORDER.loose) { fit = "loose"; gaps.unshift("Combined market: it also needs a second, unrelated event to happen before it pays."); }
  if (!/\b(exactly|between)\b/i.test(w.text) && /\bexactly\b|\bbetween\b[^?.]*\band\b|\d\s*[-–]\s*\$?\d/i.test(c.title)) {
    if (FIT_ORDER[fit] > FIT_ORDER.loose) fit = "loose"; gaps.unshift("Partial cover: it pays only if the result lands in this one bucket. Outcomes above or below it (for example more hikes than the bucket) aren't covered unless you buy every bucket.");
  }
  if ((j.side === "YES" ? c.yesAsk : c.noAsk) === null) gaps.push("No live price for this side, so it can't be costed.");
  return { ...j, fit, gaps: [...new Set(gaps)].slice(0, 6) };
}

const SCHEMA = { type: "OBJECT", properties: { ratings: { type: "ARRAY", items: { type: "OBJECT", properties: {
  index: { type: "INTEGER" }, fit: { type: "STRING", enum: ["exact", "close", "loose", "none"] }, side: { type: "STRING", enum: ["YES", "NO"] },
  covered: { type: "STRING" }, quote: { type: "STRING", nullable: true }, gaps: { type: "ARRAY", items: { type: "STRING" } } }, required: ["index", "fit", "side", "covered", "gaps"] } } }, required: ["ratings"] };
const SYSTEM = `You judge whether a prediction market is a hedge for a person's worry: does buying one side pay out when the bad thing happens to them?
The worry is the BAD outcome for the user. For each market: side = the side (YES or NO) that pays when the bad outcome happens. Watch negations: if the worry is "the Fed does NOT cut", a "Will the Fed cut?" market hedges on NO, and a "no change" market hedges on YES. fit:
- exact: same event, same threshold/region/time window; the payout happens whenever the worry happens.
- close: same event, but a small gap (a slightly different threshold, date, or region).
- loose: related or correlated (a proxy), but it can easily fail to pay when the worry happens. A combined/parlay market that also needs an unrelated event is loose at best. A market that pays on only a slice of the bad outcome (e.g. "hike 50+ bps" when the worry is "no cut", which mostly means a hold) is loose; prefer the market (or NO side) that covers the whole bad outcome.
- none: unrelated, or it does not pay when the worry happens.
Be strict. A correlated proxy is "loose" at best. covered: one plain sentence on when it pays, in the user's terms.
quote: copy ONE sentence verbatim from the market rules that defines the payout (or null). gaps: up to 3 short plain-language things NOT covered (timing, geography, definition, who decides, source). Do not mention prices.`;

/** AI ratings (null if AI unavailable). Uses the raw worry text, so it can run in parallel with understand(). */
export async function aiRate(w: Worry, cs: Candidate[], now = new Date()): Promise<FitJudgement[] | null> {
  if (!llmAvailable() || !cs.length) return null;
  try {
    const list = cs.map((c, i) => `#${i} [${c.venue}] ${c.title}\ncloses: ${c.closeTime ?? "unknown"}${c.sources.length ? `\nsettlement source: ${c.sources.join(", ")}` : ""}\nrules: ${c.rules.slice(0, 700) || "(none given)"}`).join("\n\n");
    const o = await geminiJson<{ ratings: Array<{ index: number; fit: Fit; side: "YES" | "NO"; covered: string; quote?: string | null; gaps: string[] }> }>("judge", SYSTEM,
      `Today: ${now.toISOString().slice(0, 10)}\nWorry: ${JSON.stringify(w.text)}${w.parsedBy === "ai" ? `\nParsed: ${JSON.stringify({ summary: w.summary, direction: w.direction, threshold: w.threshold, unit: w.unit, location: w.location, windowStart: w.windowStart, deadline: w.deadline })}` : ""}\n\nMarkets:\n${list}`,
      SCHEMA, 12000, process.env.HEDGE_JUDGE_THINKING || "minimal");
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
