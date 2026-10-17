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

test("loose fit is shown as the match, headline leads with the gaps; 'none' stays no good hedge", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: judgeAll("loose") } });
  try { const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [btcEvent] }, NOW);
    assert.equal(r.verdict, "hedge"); assert.equal(r.match.fit, "loose"); assert.match(r.headline, /^Loose fit, read the gaps first/); }
  finally { restore(); }
}));

test("Polymarket depth caps the cover and the headline share", () => withKey(async () => {
  const ev = { slug: "tx", title: "tx", endDate: "2026-12-01T00:00:00Z", markets: [{ id: "t", slug: "tx-landfall", question: "Will a hurricane make landfall in Texas by November 30, 2026?", description: "Resolves Yes if a hurricane makes landfall in Texas.", bestAsk: 0.09, bestBid: 0.08, outcomePrices: "[\"0.09\",\"0.91\"]", clobTokenIds: "[\"TOKYES\",\"TOKNO\"]", endDate: "2026-12-01T00:00:00Z", active: true, closed: false }] };
  const restore = stubFetch({ poly: [ev], gemini: { parse: { ...btcParse, threshold: null, direction: "happens", subject: "hurricane landfall texas", keyTerms: ["hurricane", "landfall", "texas"], searchQueries: ["hurricane texas"], summary: "hurricane hits Houston", deadline: "2026-11-02" }, judge: judgeAll("close") } });
  const f = globalThis.fetch; globalThis.fetch = (async (u: any, i: any) => String(u).includes("clob.polymarket.com") ? new Response(JSON.stringify({ asks: [{ price: "0.09", size: "95" }] })) : f(u, i)) as any;
  try { const r: any = await freeMatch({ worry: "hurricane hits Houston on my trip", amountAtRisk: 200 }, NOW);
    assert.ok(r.match, r.headline); assert.equal(r.match.payout, 95); assert.match(r.headline, /covers \$95.00 of your \$200.00 \(47.5%\)/); assert.match(r.match.warnings.join(" "), /depth/); }
  finally { globalThis.fetch = f; restore(); }
}));

test("World size unverified → headline says 'up to $X, size unverified', no percentage; orderbook in the candidate is used", () => withKey(async () => {
  const ev = JSON.parse(JSON.stringify(btcEvent)); delete ev.markets[0].yesAskQty;
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge } });
  try {
    const r: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [ev] }, NOW);
    assert.match(r.headline, /up to \$100.00 of cover, size unverified/i); assert.doesNotMatch(r.headline, /%\)/);
    ev.markets[0].orderbook = { yes: { asks: [[0.126, 80]] } };
    const r2: any = await freeMatch({ worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [ev] }, NOW);
    assert.equal(r2.match.payout, 80); assert.match(r2.headline, /covers \$80.00 of your \$100.00 \(80%\)/i);
  } finally { restore(); }
}));

test("timing: trip window lists 'pays before your trip'; no-deadline cover says 'Cover ends <date>'; any gap caps at close", async () => {
  const { codeChecks } = await import("../src/core/fit.js"); const { rulesParse } = await import("../src/core/worry.js");
  const c: any = { source: "reference", venue: "polymarket", marketId: "x", title: "Hurricane landfall in Texas by Nov 30?", rules: "NHC.", closeTime: "2026-12-01T04:59:00Z", yesAsk: 0.09, noAsk: 0.91, yesBid: null, noBid: null, yesMint: null, noMint: null, url: null, sources: [], askQty: { yes: null, no: null } };
  const j = { marketId: "x", fit: "exact" as const, side: "YES" as const, covered: "", gaps: [], quote: null, by: "ai" as const };
  const trip = codeChecks({ ...rulesParse("hurricane houston trip", NOW), windowStart: "2026-10-28", deadline: "2026-11-02" }, c, j, NOW);
  assert.match(trip.gaps.join(" "), /before your window starts/); assert.equal(trip.fit, "close");
  const open = codeChecks({ ...rulesParse("bitcoin below 55k", NOW), deadline: null, threshold: null }, { ...c, title: "Bitcoin below $55,000 in 2026?", closeTime: "2026-12-31T23:00:00Z" }, j, NOW);
  assert.match(open.gaps.join(" "), /Cover ends 31 December 2026/); assert.equal(open.fit, "close");
});

test("402 challenge is mirrored into the JSON body", async () => {
  const { mirrorChallenge } = await import("../src/app.js"); const { Hono } = await import("hono");
  const pr = { x402Version: 2, resource: { url: "https://h/v1/plan" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000" }] };
  const app = new Hono(); app.use("*", mirrorChallenge); app.post("/x", (c) => { c.header("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(pr)).toString("base64")); return c.json({}, 402); });
  const r = await app.request("/x", { method: "POST" }); assert.equal(r.status, 402); assert.ok(r.headers.get("payment-required"));
  assert.deepEqual(await r.json(), pr);
});

test("bet reply uses the non-refundable trip example", async () => {
  const r: any = await freeMatch({ worry: "I think the Lakers win tonight, put $50 on it", amountAtRisk: 50 }, NOW);
  assert.match(r.headline, /non-refundable .* trip .* if they don't advance/);
});

test("job loss vs recession market is loose (proxy gap first)", async () => {
  const { codeChecks } = await import("../src/core/fit.js"); const { rulesParse } = await import("../src/core/worry.js");
  const c: any = { source: "reference", venue: "polymarket", marketId: "r", title: "US recession by end of 2026?", rules: "Resolves Yes if NBER declares a recession.", closeTime: "2027-01-31T00:00:00Z", yesAsk: 0.08, noAsk: 0.92, yesBid: null, noBid: null, yesMint: null, noMint: null, url: null, sources: [], askQty: { yes: null, no: null } };
  const r = codeChecks(rulesParse("I'm worried I lose my job in a US recession", NOW), c, { marketId: "r", fit: "close", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.equal(r.fit, "loose"); assert.match(r.gaps[0]!, /^Proxy/);
});
