// Understand the user's worry. AI does the reading; a rules parser is the fallback. No prices here.
import { geminiJson, llmAvailable } from "./llm.js";
import type { Worry } from "./types.js";

const SCHEMA = { type: "OBJECT", properties: {
  summary: { type: "STRING" }, category: { type: "STRING", enum: ["fx", "weather", "macro", "crypto", "politics", "sports", "rates", "commodity", "other"] },
  subject: { type: "STRING" }, direction: { type: "STRING", enum: ["above", "below", "happens", "unknown"] },
  threshold: { type: "NUMBER", nullable: true }, unit: { type: "STRING", nullable: true }, location: { type: "STRING", nullable: true },
  deadline: { type: "STRING", nullable: true, description: "YYYY-MM-DD" }, windowStart: { type: "STRING", nullable: true, description: "YYYY-MM-DD" },
  searchQueries: { type: "ARRAY", items: { type: "STRING" } }, keyTerms: { type: "ARRAY", items: { type: "STRING" } },
}, required: ["summary", "category", "subject", "direction", "searchQueries", "keyTerms"] };

const SYSTEM = (today: string) => `You turn a person's real-life financial worry into a precise event that a prediction market could pay out on.
Today is ${today}. For scheduled events (an FOMC meeting, an election, a data release) the deadline is the day it is decided if you know it. Resolve relative dates ("before Dec" = the last day of November this year unless clearly next year; "during my Oct 28 trip" = windowStart and deadline around that date).
- summary: the BAD event in one plain line: the thing that, if it happens, costs the user money. Keep negations ("the Fed does NOT cut in December" stays a non-cut).
- direction: "above"/"below" when the worry is a number crossing a threshold, else "happens".
- threshold/unit: the number and unit if any (e.g. 2000, "NGN per USD"; 100000, "USD per BTC").
- searchQueries: 3 short search phrases a prediction-market search box would match (market-style wording, e.g. "Nigerian naira", "USD NGN", "hurricane Texas landfall"). No dates in queries.
- keyTerms: 3-8 lowercase words that a matching market's rules must mention.
Never invent facts about markets. Return JSON only.`;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
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
    threshold, unit: null, location: null, deadline, windowStart: null, searchQueries: [words.slice(0, 3).join(" ")].filter(Boolean), keyTerms: words.slice(0, 6), parsedBy: "rules" };
}

export async function understand(text: string, now = new Date()): Promise<Worry> {
  if (!llmAvailable()) return rulesParse(text, now);
  try {
    const o = await geminiJson<Omit<Worry, "text" | "parsedBy">>("parse", SYSTEM(now.toISOString().slice(0, 10)), `Worry: ${JSON.stringify(text)}`, SCHEMA, 7000);
    return { ...rulesParse(text, now), ...o, text, searchQueries: (o.searchQueries ?? []).slice(0, 4), keyTerms: (o.keyTerms ?? []).map((k) => k.toLowerCase()).slice(0, 8), parsedBy: "ai" };
  } catch { return rulesParse(text, now); }
}
