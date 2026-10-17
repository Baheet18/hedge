import { test } from "node:test";
import assert from "node:assert/strict";
import { freeMatch } from "../src/core/plan.js";
import { config, networks, paidMode } from "../src/config.js";
import { createApp } from "../src/app.js";
import { btcEvent } from "./fixtures/world.js";
import { stubFetch } from "./stub.js";

const NOW = new Date("2026-10-17T11:00:00Z");
const btcParse = { summary: "Bitcoin falls below $55,000 before the end of 2026", category: "crypto", subject: "bitcoin price", direction: "below", threshold: 55000, unit: "USD per BTC", location: null, deadline: "2026-12-31", windowStart: null, searchQueries: ["bitcoin below", "bitcoin price 2026"], keyTerms: ["bitcoin", "btc", "below", "55,000"], isBet: false };
const judge = (p: string) => { const l = p.split("\n").find((x) => x.startsWith("#") && x.includes("55,000"))!; return { ratings: [{ index: Number(l.slice(1, l.indexOf(" "))), fit: "exact", side: "YES", covered: "Pays if BTC trades below $55,000 in 2026.", quote: "then the market resolves to Yes", gaps: ["Chainlink price, not your exchange."] }] }; };
const withKey = async (fn: () => Promise<void>) => { process.env.GEMINI_API_KEY = "k"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } };

test("free match: best World market + price + cost to cover, without paid detail", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge } });
  try {
    const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [btcEvent] }, NOW);
    assert.equal(r.tier, "free"); assert.equal(r.verdict, "hedge");
    assert.equal(r.match.marketId, "WXBTCYR-26LOW-B55K"); assert.equal(r.match.side, "YES"); assert.equal(r.match.price, 0.126);
    assert.ok(r.match.costToCover > 12 && r.match.costToCover < 14); assert.equal(r.match.payout, 100);
    const s = JSON.stringify(r); assert.doesNotMatch(s, /rulesQuote|outcomeMint|YESb55kMint/); assert.ok(Array.isArray(r.match.whatsNotCovered)); assert.match(r.headline, /Covers \$100.00 of your \$100.00 \(100%\)/);
    assert.deepEqual(r.worldSearch, []); assert.match(r.next.join(" "), /hedge_plan/);
  } finally { restore(); }
}));

test("free match without candidates: returns the single world_search query to run", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: () => ({ ratings: [] }) } });
  try {
    const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100 }, NOW);
    assert.equal(r.match, null); assert.ok(r.worldSearch.length > 0); assert.match(r.next[0], /world_search once/);
  } finally { restore(); }
}));

test("POST /v1/match is free and defaults amountAtRisk to $100", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge } });
  try {
    const res = await createApp().request("/v1/match", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ worry: "Bitcoin drops below $55k", candidates: [btcEvent] }) });
    assert.equal(res.status, 200); const d: any = await res.json(); assert.equal(d.amountAtRisk, 100); assert.equal(d.match.marketId, "WXBTCYR-26LOW-B55K");
    assert.equal((await createApp().request("/v1/match", { method: "POST", body: "{}" })).status, 400);
  } finally { restore(); }
}));

test("fee defaults to 1¢; networks list Solana first when a Solana payTo is set", () => {
  assert.equal(config.price, process.env.HEDGE_PRICE || "$0.01");
  const save = { ...config };
  try {
    Object.assign(config, { payTo: "0xabc", payToSolana: "", facilitatorUrl: "https://f" }); assert.deepEqual(networks(), ["eip155:8453"]); assert.ok(paidMode());
    Object.assign(config, { payToSolana: "So1ana" }); assert.equal(networks()[0], config.solanaNetwork); assert.equal(networks().length, 2);
    Object.assign(config, { payTo: "" }); assert.deepEqual(networks(), [config.solanaNetwork]); assert.ok(paidMode());
  } finally { Object.assign(config, save); }
});

const btc74 = { slug: "bitcoin-price-on-october-17-2026", title: "Bitcoin price on October 17?", endDate: "2026-10-17T16:00:00Z",
  markets: [{ id: "b74", slug: "will-the-price-of-bitcoin-be-less-than-74000-on-october-17-2026", question: "Will the price of Bitcoin be less than $74,000 on October 17?", description: "Resolves Yes if the Binance BTC/USDT 1-minute candle close at 12:00 ET on October 17 is below $74,000.", bestAsk: 0.001, bestBid: 0, outcomePrices: JSON.stringify(["0.001", "0.999"]), endDate: "2026-10-17T16:00:00Z", active: true, closed: false }] };
const judgeAll = (fit: string) => (p: string) => ({ ratings: p.split("\n").filter((l) => l.startsWith("#")).map((l) => ({ index: Number(l.slice(1, l.indexOf(" "))), fit, side: "YES", covered: "Pays if BTC is below the line.", quote: null, gaps: [] })) });

test("live bug: today-closing $74k Polymarket market at 0.1¢ is not a hedge for 'BTC below $55k'", () => withKey(async () => {
  const restore = stubFetch({ poly: [btc74], gemini: { parse: { ...btcParse, deadline: null }, judge: judgeAll("close") } });
  try {
    const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100 }, NOW);
    assert.equal(r.verdict, "no_good_hedge", r.headline); assert.equal(r.match, null);
    assert.match(r.headline, /world_search/); assert.match(r.next.join(" "), /world_search/);
  } finally { restore(); }
}));

test("timing: market closing within 48h caps at loose; sub-1¢ price is never good cover", async () => {
  const { codeChecks } = await import("../src/core/fit.js"); const { rulesParse } = await import("../src/core/worry.js");
  const w = { ...rulesParse("bitcoin below 55k", NOW), threshold: 55000, direction: "below" as const, deadline: null };
  const c: any = { source: "reference", venue: "polymarket", marketId: "x", title: "Bitcoin below $55,000 today?", rules: "", closeTime: "2026-10-17T20:00:00Z", yesAsk: 0.3, noAsk: 0.7, yesBid: null, noBid: null, yesMint: null, noMint: null, url: null, sources: [], askQty: { yes: null, no: null } };
  const r = codeChecks(w, c, { marketId: "x", fit: "exact", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.equal(r.fit, "loose"); assert.match(r.gaps[0]!, /next \d+ hours/);
  const far = codeChecks(w, { ...c, title: "Bitcoin below $74,000 in 2026?", closeTime: "2027-01-01T00:00:00Z" }, { marketId: "x", fit: "close", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.equal(far.fit, "loose");
});

test("nearest threshold wins among equal fits", () => withKey(async () => {
  const ev = { ...btcEvent, markets: [btcEvent.markets[1], { ...btcEvent.markets[0] }] };
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: judgeAll("close") } });
  try { const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [ev] }, NOW); assert.equal(r.match.marketId, "WXBTCYR-26LOW-B55K"); }
  finally { restore(); }
}));

test("missing askQty = size unverified (still recommended, warned), never zero", () => withKey(async () => {
  const ev = JSON.parse(JSON.stringify(btcEvent)); delete ev.markets[0].yesAskQty;
  const restore = stubFetch({ poly: [], gemini: { parse: { ...btcParse, threshold: 50000, summary: "Bitcoin falls below $50,000" }, judge } });
  try {
    const r: any = await freeMatch({ worry: "Bitcoin drops below $50k", amountAtRisk: 1000, candidates: [ev] }, NOW);
    assert.notEqual(r.verdict, "no_good_hedge", r.headline); assert.equal(r.match.payout, 1000);
    assert.match(r.match.warnings.join(" "), /Size not checked: run world_orderbook/);
  } finally { restore(); }
}));

test("Lakers bet → 'bet, not a hedge' and asks what loss they're protecting", async () => {
  const r: any = await freeMatch({ worry: "I think the Lakers win tonight, put $50 on it", amountAtRisk: 50 }, NOW);
  assert.equal(r.verdict, "not_a_hedge"); assert.match(r.headline, /bet, not a hedge/); assert.match(r.headline, /What loss are you protecting/); assert.match(r.next.join(" "), /tickets/);
});

test("exact with a timing/place gap drops to close; publication lag flagged", async () => {
  const { codeChecks } = await import("../src/core/fit.js"); const { rulesParse } = await import("../src/core/worry.js");
  const w = { ...rulesParse("hurricane hits Houston during my trip", NOW), deadline: "2026-11-02" };
  const c: any = { source: "reference", venue: "polymarket", marketId: "x", title: "Hurricane landfall in Texas by Nov 30?", rules: "Resolves Yes per NHC advisories.", closeTime: "2026-12-01T00:00:00Z", yesAsk: 0.05, noAsk: 0.95, yesBid: null, noBid: null, yesMint: null, noMint: null, url: null, sources: [], askQty: { yes: null, no: null } };
  assert.equal(codeChecks(w, c, { marketId: "x", fit: "exact", side: "YES", covered: "", gaps: ["Covers all of Texas, a wider area than Houston."], quote: null, by: "ai" }, NOW).fit, "close");
  const g = codeChecks({ ...w, deadline: "2026-12-31" }, { ...c, title: "US recession in 2026?", rules: "Resolves Yes if Q4 2026 GDP growth is negative in the BEA advance estimate.", closeTime: "2027-02-28T00:00:00Z" }, { marketId: "x", fit: "loose", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.match(g.gaps.join(" "), /Publication lag/);
});

test("fit 'none' headline doesn't mention a closest market; x402 timeout 600s", async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: judgeAll("none") } });
  try { await withKey(async () => { const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [btcEvent] }, NOW);
    assert.equal(r.verdict, "no_good_hedge"); assert.doesNotMatch(r.headline, /closest/); assert.match(r.headline, /no listed market pays/); }); }
  finally { restore(); }
  const fs = await import("node:fs"); const src = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.ok(!/maxTimeoutSeconds: 120/.test(src) && /maxTimeoutSeconds: 600/.test(src));
});

test("Polymarket ranking prefers the threshold nearest the user's among many BTC lines", async () => {
  const { referenceCandidates } = await import("../src/core/universe.js"); const { overlap } = await import("../src/core/fit.js");
  const ev = { slug: "btc-2026", title: "What price will Bitcoin hit in 2026?", endDate: "2027-01-01T00:00:00Z", markets: Array.from({ length: 40 }, (_, i) => { const k = 150 - i * 3; return { id: `m${k}`, slug: `btc-${k}k`, question: `Will Bitcoin dip to $${k},000 in 2026?`, description: "Bitcoin price", bestAsk: 0.2, bestBid: 0.19, outcomePrices: "[\"0.2\",\"0.8\"]", endDate: "2027-01-01T00:00:00Z", active: true, closed: false }; }) };
  const restore = stubFetch({ poly: [ev] });
  try { const { rulesParse } = await import("../src/core/worry.js"); const w = { ...rulesParse("bitcoin below 55k", NOW), threshold: 55000, keyTerms: ["bitcoin"] };
    const near = (c: any) => { const n = Number(/\$(\d+),000/.exec(c.title)![1]) * 1000; return Math.max(0, 0.5 - Math.abs(n - 55000) / 55000); };
    const r = await referenceCandidates(["bitcoin"], (c) => overlap(w, c) + near(c), 6); assert.match(r.candidates[0]!.title, /\$54,000|\$57,000/);
  } finally { restore(); }
});

test("no good hedge still shows a loose reference as closestNotRecommended (never a 'none' one)", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: judgeAll("loose") } });
  try { const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [btcEvent] }, NOW);
    assert.equal(r.verdict, "no_good_hedge"); assert.equal(r.match, null); assert.equal(r.closestNotRecommended.fit, "loose"); assert.match(r.closestNotRecommended.why, /don't buy/); }
  finally { restore(); }
}));
