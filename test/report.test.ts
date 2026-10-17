// Fixes from the Oct 17 test report: none-fit alternatives, definition gaps, near-miss strikes, timeframe, missing World.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, monthQueries, inWindow } from "../src/core/plan.js";
import { codeChecks, definitionGaps } from "../src/core/fit.js";
import { rulesParse, thisMonthDeadline } from "../src/core/worry.js";
import type { Candidate } from "../src/core/types.js";
import { stubFetch, polyEvent } from "./stub.js";

const NOW = new Date("2026-10-17T11:00:00Z");
const cand = (title: string, rules = "", closeTime = "2026-11-30T23:59:00Z"): Candidate => ({ source: "reference", venue: "polymarket", marketId: title, title, rules, closeTime, yesAsk: 0.1, noAsk: 0.9, yesBid: null, noBid: null, yesMint: null, noMint: null, url: "", sources: [], askQty: { yes: null, no: null } } as Candidate);
const withKey = async (fn: () => Promise<void>) => { process.env.GEMINI_API_KEY = "k"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } };
const rate = (p: string, f: (title: string) => { fit: string; gaps?: string[] }) => ({ ratings: p.split("\n").filter((l) => /^#\d+ /.test(l)).map((l) => { const i = Number(l.slice(1, l.indexOf(" "))); const r = f(l); return { index: i, fit: r.fit, side: "YES", covered: "Pays if it happens.", quote: null, gaps: r.gaps ?? [] }; }) });

test("1) alternatives never include fit 'none' markets", () => withKey(async () => {
  const parse = { summary: "A hurricane makes landfall in Texas this season", category: "weather", subject: "hurricane landfall Texas", direction: "happens", threshold: null, unit: null, location: "Texas", deadline: "2026-11-30", windowStart: null, searchQueries: ["hurricane landfall texas"], keyTerms: ["hurricane", "texas", "landfall"], isBet: false };
  const ev = polyEvent("hurricanes", [{ q: "Will a hurricane make landfall in Texas in 2026?", desc: "Resolves Yes if a hurricane makes landfall in Texas.", ask: 0.09 }, { q: "Will a cyclone make landfall in China hurricane texas?", ask: 0.3 }, { q: "Hurricane landfall in Florida texas?", ask: 0.2 }]);
  const restore = stubFetch({ poly: [ev], gemini: { parse, judge: (p) => rate(p, (l) => ({ fit: /in Texas in 2026/.test(l) ? "exact" : /China/.test(l) ? "none" : "loose" })) } });
  try { const p = await plan({ worry: "My business in Houston loses money if a hurricane hits Texas this season", amountAtRisk: 500 }, NOW);
    assert.match(p.best!.market.title, /Texas in 2026/);
    assert.ok(p.alternatives.length >= 1 && p.alternatives.every((o) => o.fit !== "none"), JSON.stringify(p.alternatives.map((o) => o.fit)));
    // 2) exact fit still lists the landfall definition gap
    assert.ok(p.best!.whatsNotCovered.some((g) => /landfall/.test(g) && /tropical storm/.test(g) && /Louisiana/.test(g)), p.best!.whatsNotCovered.join("|"));
    // 7) no World candidates: the response says so
    assert.equal((p as any).worldIncluded, false); assert.match(p.headline, /World markets weren't included/); assert.match(p.next[0]!, /World markets were NOT included/);
  } finally { restore(); }
}));

test("2) exact fit keeps fit and gets a non-empty 'not covered'", () => {
  const w = rulesParse("hurricane hits Texas", NOW);
  const c = cand("Will a hurricane make landfall in Texas in 2026?", "Resolves Yes if a hurricane makes landfall in Texas per NHC.");
  const r = codeChecks({ ...w, deadline: "2026-11-30" }, c, { marketId: "x", fit: "exact", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.equal(r.fit, "exact"); assert.ok(r.gaps.length > 0 && /Louisiana/.test(r.gaps.join(" ")));
  assert.ok(definitionGaps(w, cand("Will the Fed cut?", "Resolves per the Fed statement.")).length === 1);
});

test("3) near-miss strike: oil above $115 for a $100 worry is loose with 'pays from $115, not $100'", () => {
  const w = { ...rulesParse("Oil going above $100 would wreck my delivery business", NOW), threshold: 100, direction: "above" as const };
  const r = codeChecks(w, cand("Will WTI crude oil close above $115 in 2026?", "Resolves Yes if WTI settles above $115."), { marketId: "x", fit: "close", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.equal(r.fit, "loose"); assert.ok(r.gaps.some((g) => /pays from \$115, not \$100/.test(g)), r.gaps.join("|"));
  const far = codeChecks(w, cand("Will WTI crude oil close above $200 in 2026?"), { marketId: "y", fit: "close", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.equal(far.fit, "none");
});

test("4) timeframe: 'this month' → Oct 31, month queries, in-window ranks first and the longer pick is explained", () => withKey(async () => {
  assert.equal(thisMonthDeadline("lose if BTC drops below $55k this month", NOW), "2026-10-31");
  const w0 = { ...rulesParse("eth below 2000", NOW), deadline: "2026-10-31", direction: "below" as const };
  assert.deepEqual(monthQueries(w0, "eth", NOW), ["ethereum october", "ethereum dip"]);
  assert.equal(inWindow(w0, "2026-11-01T03:59:00Z", NOW), true); assert.equal(inWindow(w0, "2026-12-31T23:59:00Z", NOW), false);
  const parse = { summary: "BTC falls below $55k this month", category: "crypto", subject: "bitcoin price", direction: "below", threshold: 55000, unit: "USD", location: null, deadline: null, windowStart: null, searchQueries: ["bitcoin price"], keyTerms: ["bitcoin", "btc", "55000"], isBet: false };
  const ev = polyEvent("btc", [{ q: "Will Bitcoin dip to $55,000 by December 31, 2026?", desc: "Bitcoin price", ask: 0.11, end: "2026-12-31T23:59:00Z" }, { q: "Will Bitcoin dip to $55,000 in October?", desc: "Bitcoin price", ask: 0.012, end: "2026-11-01T03:59:00Z" }]);
  let queries = "";
  const restore = stubFetch({ poly: [ev], gemini: { parse, judge: (p) => rate(p, () => ({ fit: "close" })) } });
  try { const p = await plan({ worry: "I hold $100 of Bitcoin and lose if it drops below $55k this month", amountAtRisk: 100 }, NOW); queries = p.searched.polymarketQueries!.join(",");
    assert.equal(p.worry.deadline, "2026-10-31"); assert.match(queries, /bitcoin october/);
    assert.match(p.best!.market.title, /in October/);
  } finally { restore(); }
  const restore2 = stubFetch({ poly: [ev], gemini: { parse, judge: (p) => rate(p, (l) => ({ fit: /December/.test(l) ? "close" : "loose" })) } });
  try { const p = await plan({ worry: "I hold $100 of Bitcoin and lose if it drops below $55k this month", amountAtRisk: 100 }, NOW);
    assert.match(p.best!.market.title, /December/); assert.match(p.headline, /Picked over the cheaper in-window/);
  } finally { restore2(); }
}));
