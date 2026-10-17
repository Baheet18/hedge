// Understand the user's worry. AI does the reading; a rules parser is the fallback. No prices here.
import { geminiJson, llmAvailable } from "./llm.js";
import type { Worry } from "./types.js";

const SCHEMA = { type: "OBJECT", properties: {
  summary: { type: "STRING" }, category: { type: "STRING", enum: ["fx", "weather", "macro", "crypto", "politics", "sports", "rates", "commodity", "other"] },
  subject: { type: "STRING" }, direction: { type: "STRING", enum: ["above", "below", "happens", "unknown"] },
  threshold: { type: "NUMBER", nullable: true }, unit: { type: "STRING", nullable: true }, location: { type: "STRING", nullable: true },
  deadline: { type: "STRING", nullable: true, description: "YYYY-MM-DD" }, windowStart: { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
  searchQueries: { type: "ARRAY", items: { type: "STRING" } }, keyTerms: { type: "ARRAY", items: { type: "STRING" } },
  isBet: { type: "BOOLEAN", description: "true if the user wants to speculate/bet on an outcome rather than protect against a loss they would suffer" },
}, required: ["summary", "isBet", "category", "subject", "direction", "searchQueries", "keyTerms"] };

const SYSTEM = (today: string) => `You turn a person's real-life financial worry into a precise event that a prediction market could pay out on.
Today is ${today}. For scheduled events (an FOMC meeting, an election, a data release) the deadline is the day it is decided if you know it. Resolve relative dates ("before Dec" = the last day of November this year unless clearly next year; "during my Oct 28 trip" = windowStart and deadline around that date).
- summary: the BAD event in one plain line, in the user's own scope: keep their place, date and definition exactly (\"rain on the wedding day\" stays on the day; \"I lose my job in a recession\" stays a job loss, don't widen it to \"a recession is declared or GDP falls\"). Keep negations ("the Fed does NOT cut in December" stays a non-cut).
- direction: "above"/"below" when the worry is a number crossing a threshold, else "happens".
- threshold/unit: the number and unit if any (e.g. 2000, "NGN per USD"; 100000, "USD per BTC").
- searchQueries: 3 short search phrases a prediction-market search box would match (market-style wording, e.g. "Nigerian naira", "USD NGN", "hurricane Texas landfall"). No dates in queries. Markets are rarely city-level: include one query at the wider region level (the state or country, e.g. "hurricane landfall Texas" for Houston) and one with just the core event (e.g. "hurricane landfall").
- keyTerms: 3-8 lowercase words that a matching market's rules must mention.
- isBet: true when the user is betting on an outcome they want or predict (\"I think the Knicks will win, put money on it\") rather than protecting against a loss that happens to them. A hedge needs a real exposure.
Never invent facts about markets. Return JSON only.`;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Speculation, not protection: "put money on", "bet on", "I think X will win" with no stated loss. */
export function isBetText(t: string): boolean {
  const s = t.toLowerCase();
  const betty = /\b(put (some )?money on|put \$?\d[\d,.]*k? on|bet (\$?\d[\d,.]*k? )?on|place a bet|wager|i think .{1,60} (will )?(win|wins|beat|beats|happen)|make (some )?money|easy money|lock|parlay|odds on)\b/.test(s);
  const exposure = /\b(worried|worry|afraid|scared|lose|loss|at risk|wreck|hurt|cost me|my (job|house|rent|savings|business|flight|trip|wedding|crop|salary|mortgage)|insure|protect|hedge|cover)\b/.test(s);
  return betty && !exposure;
}
export function rulesParse(text: string, now = new Date()): Worry {
  const t = text.toLowerCase();
  const num = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/);
  const threshold = num ? Number(num[1]!.replace(/,/g, "")) * (num[2] ? 1000 : 1) : null;
  const cat = /naira|ngn|cedi|rand|peso|lira|fx|exchange rate|dollar|\/\$|usd/.test(t) ? "fx" : /hurricane|storm|flood|rain|snow|heat|weather|typhoon/.test(t) ? "weather"
    : /recession|gdp|unemployment|inflation|cpi/.test(t) ? "macro" : /bitcoin|btc|eth|crypto|solana/.test(t) ? "crypto" : /fed|rate (cut|hike)|interest rate/.test(t) ? "rates"
    : /election|president|vote|win the|governor|senate/.test(t) ? "politics" : /oil|gold|gas price/.test(t) ? "commodity" : "other";
  const mi = MONTHS.findIndex((m) => new RegExp(`\\b${m}`).test(t));
  let deadline: string | null = null;
  if (mi >= 0) { const before = /before|by/.test(t); let y = now.getUTCFullYear(); if (mi < now.getUTCMonth()) y++;
    const d = before ? new Date(Date.UTC(y, mi, 0)) : new Date(Date.UTC(y, mi + 1, 0)); deadline = d.toISOString().slice(0, 10); }
  const words = t.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["and", "for", "are", "but", "not", "you", "our", "get", "has", "its", "was", "out", "his", "her", "too", "can", "end", "before", "during", "worried", "worry", "about", "what", "hits", "will", "that", "this", "with", "risk", "lose", "paid", "goes", "going", "my", "if", "the", "end", "from", "they", "there", "could", "might", "have", "when", "afraid", "scared", "concerned", "savings", "money", "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december", "next", "year", "month", "week"].includes(w));
  return { text, summary: text.slice(0, 160), category: cat, subject: words.slice(0, 3).join(" "), direction: /below|under|falls? (below|under)|drop/.test(t) ? "below" : /above|over|hits|reach|exceed|past/.test(t) && threshold ? "above" : "happens",
    threshold, unit: null, location: null, deadline, windowStart: null, isBet: isBetText(t), searchQueries: [words.slice(0, 3).join(" ")].filter(Boolean), keyTerms: words.slice(0, 6), parsedBy: "rules" };
}

const ASSETS: Array<[RegExp, string, string[]]> = [
  [/\b(bitcoin|btc)\b/, "bitcoin", ["bitcoin", "btc"]], [/\b(ethereum|eth|ether)\b/, "ethereum", ["ethereum", "eth"]], [/\b(solana|sol)\b/, "solana", ["solana", "sol"]],
  [/\b(xrp|ripple)\b/, "xrp", ["xrp"]], [/\b(dogecoin|doge)\b/, "dogecoin", ["dogecoin", "doge"]],
];
/** Simple "<asset> drops below / rises above <number>" worries need no AI to parse. Returns null when unsure. */
export function regexParse(text: string, now = new Date()): Worry | null {
  const t = text.toLowerCase().replace(/(\d),(\d{3})/g, "$1$2");
  if (t.length > 160 || /\b(if|unless|and|or|while|during|trip|wedding|job|my|before|by|after|until)\b/.test(t.replace(/^(i'm |i am )?(worried|scared|afraid)( that)?\s*/, ""))) return null;
  const a = ASSETS.find(([re]) => re.test(t)); if (!a) return null;
  const m = /\b(drops?|falls?|crash(es)?|dips?|goes|sinks?|below|under|rises?|above|over|hits?|passes|exceeds?)\b[^\d$]{0,20}\$?\s?(\d+(?:\.\d+)?)\s*(k|m)?\b/.exec(t); if (!m) return null;
  const threshold = Number(m[3]) * (m[4] === "k" ? 1e3 : m[4] === "m" ? 1e6 : 1);
  const below = /drop|fall|crash|dip|sink|below|under/.test(m[0]) && !/above|over|rise|exceed/.test(m[0]);
  if (/goes|hits?|passes/.test(m[0]) && !/below|under|above|over/.test(m[0])) return null;
  const dir = below ? "below" : "above"; const n = threshold.toLocaleString("en-US");
  return { ...rulesParse(text, now), text, summary: `${a[1][0]!.toUpperCase()}${a[1].slice(1)} ${below ? "falls below" : "rises above"} $${n}`, category: "crypto", subject: `${a[1]} price`,
    direction: dir, threshold, unit: "USD", location: null, deadline: null, windowStart: null, isBet: isBetText(text),
    searchQueries: [`${a[1]} price`, `${a[1]} ${dir}`, a[1]], keyTerms: [...a[2], dir, n], parsedBy: "regex" };
}

// FOMC decision days (statement day). "Next meeting" means the next one of these, not a guess.
const FOMC = ["2026-10-28", "2026-12-09", "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08"];
export function fedNextMeeting(text: string, now = new Date()): string | null {
  if (!/\b(fed|fomc|federal reserve)\b/i.test(text) || !/\bnext (fed |fomc )?(meeting|decision)\b/i.test(text)) return null;
  const today = now.toISOString().slice(0, 10); return FOMC.find((d) => d >= today) ?? null;
}
const withFed = (w: Worry, now: Date): Worry => { const d = fedNextMeeting(w.text, now); return d ? { ...w, deadline: d, category: "rates" } : w; };

const parseCache = new Map<string, { at: number; w: Worry }>();
export async function understand(text: string, now = new Date()): Promise<Worry> {
  const rx = regexParse(text, now); if (rx) return rx;
  if (!llmAvailable()) return withFed(rulesParse(text, now), now);
  const key = text.toLowerCase().replace(/\s+/g, " ").trim(); const hit = parseCache.get(key);
  if (hit && process.env.HEDGE_NO_CACHE !== "1" && Date.now() - hit.at < 6 * 36e5) return withFed({ ...hit.w, text }, now);
  try {
    const o = await geminiJson<Omit<Worry, "text" | "parsedBy">>("parse", SYSTEM(now.toISOString().slice(0, 10)), `Worry: ${JSON.stringify(text)}`, SCHEMA, Number(process.env.HEDGE_PARSE_MS ?? 3500), process.env.HEDGE_PARSE_THINKING || "minimal");
    const w: Worry = { ...rulesParse(text, now), ...o, isBet: !!o.isBet || isBetText(text), text, searchQueries: (o.searchQueries ?? []).slice(0, 4), keyTerms: (o.keyTerms ?? []).map((k) => k.toLowerCase()).slice(0, 8), parsedBy: "ai" };
    if (parseCache.size > 500) parseCache.clear(); parseCache.set(key, { at: Date.now(), w }); return withFed(w, now);
  } catch { return withFed(rulesParse(text, now), now); }
}
