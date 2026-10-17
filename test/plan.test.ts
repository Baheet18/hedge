import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, preview } from "../src/core/plan.js";
import { costToCover } from "../src/core/math.js";
import { normalizeWorldAll, referenceCandidates, renderText } from "../src/core/universe.js";
import { overlap } from "../src/core/fit.js";
import { rulesParse, isBetText } from "../src/core/worry.js";
import { btcEvent, fedExactly2 } from "./fixtures/world.js";
import { polyEvent, stubFetch } from "./stub.js";

const NOW = new Date("2026-10-17T11:00:00Z");
const withKey = async (fn: () => Promise<void>) => { process.env.GEMINI_API_KEY = "test-key"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } };
const idx = (prompt: string, needle: string) => { const m = prompt.split("\n").find((l) => l.startsWith("#") && l.includes(needle)); return m ? Number(m.slice(1, m.indexOf(" "))) : -1; };
const BTC_WORRY = "My savings are in Bitcoin. If it crashes below $55k this year I'm wrecked. Cover $100.";
const btcParse = { summary: "Bitcoin falls below $55,000 before the end of 2026", category: "crypto", subject: "bitcoin price", direction: "below", threshold: 55000, unit: "USD per BTC", location: null, deadline: "2026-12-31", windowStart: null, searchQueries: ["bitcoin below", "bitcoin price 2026"], keyTerms: ["bitcoin", "btc", "below", "55,000"], isBet: false };
const houstonPoly = [
  polyEvent("hurricane-landfall-by-november-30", [{ q: "Will a hurricane make landfall in Texas by November 30, 2026?", desc: "This market will resolve to \"Yes\" if a hurricane makes landfall in Texas between market creation and November 30, 2026, 11:59 PM ET, as described in official National Hurricane Center (NHC) advisories. Otherwise No.", ask: 0.03, end: "2026-12-01T04:59:00Z" },
    { q: "Will a hurricane make landfall in Florida by November 30, 2026?", ask: 0.06 }]),
  ...Array.from({ length: 4 }, (_, i) => polyEvent(`nhl-${i}`, Array.from({ length: 8 }, (_, k) => ({ q: `Will the Carolina Hurricanes beat team ${i}-${k}?`, ask: 0.5 })))),
];

test("World template rules render with token values; event settlementSources carried", () => {
  const cs = normalizeWorldAll(btcEvent);
  assert.equal(cs.length, 2); const c = cs[0]!;
  assert.equal(c.marketId, "WXBTCYR-26LOW-B55K"); assert.match(c.title, /Bitcoin below \$55,000 in 2026\?/);
  assert.match(c.rules, /trades below \$55,000 at any time before December 31, 2026/); assert.doesNotMatch(c.rules, /object Object|\{threshold\}/);
  assert.deepEqual(c.sources, ["Chainlink https://data.chain.link/streams/btc-usd"]); assert.equal(c.askQty.yes, 2000);
  assert.equal(c.yesMint, "YESb55kMint1111111111111111111111111111111");
  assert.equal(renderText({ template: "{{a}} and ${b}", tokens: { a: { value: "x" }, b: "y" } }), "x and y");
});

test("reference search merges queries, ranks by overlap before capping, drops zero overlap", async () => {
  const restore = stubFetch({ poly: houstonPoly });
  try {
    const w = { ...rulesParse("hurricane Houston landfall Texas", NOW), keyTerms: ["hurricane", "landfall", "texas", "houston"] };
    const r = await referenceCandidates(["hurricane Houston landfall", "Texas hurricane"], (c) => overlap(w, c), 6);
    assert.match(r.candidates[0]!.title, /Texas/); assert.equal(r.candidates.length, 6);
    const w2 = { ...w, keyTerms: ["zzz"], subject: "zzz" };
    assert.equal((await referenceCandidates(["x"], (c) => overlap(w2, c))).candidates.length, 0);
  } finally { restore(); }
});

test("demo: BTC below $55k → World WXBTCYR-26LOW-B55K YES ~12.6¢, buyable", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: (p) => ({ ratings: [
    { index: idx(p, "B55K") >= 0 ? idx(p, "55,000") : 0, fit: "exact", side: "YES", covered: "Pays $1 a share if Bitcoin trades below $55,000 any time before the end of 2026.", quote: "then the market resolves to Yes", gaps: ["Uses the Chainlink price, not your exchange's price."] },
    { index: idx(p, "40,000"), fit: "loose", side: "YES", covered: "Only pays below $40,000.", quote: null, gaps: ["A drop to $50k isn't covered."] }] }) } });
  try {
    const p = await plan({ worry: BTC_WORRY, amountAtRisk: 100, candidates: [btcEvent] }, NOW);
    assert.equal(p.verdict, "hedge", p.headline); assert.equal(p.best!.market.marketId, "WXBTCYR-26LOW-B55K");
    assert.equal(p.best!.cost!.price, 0.126); assert.equal(p.execute!.side, "YES"); assert.equal(p.execute!.outcomeMint, "YESb55kMint1111111111111111111111111111111");
    assert.equal(p.execute!.amountUsd, costToCover(0.126, 100).cost);
    assert.match(p.best!.whatsCovered, /Chainlink/); assert.match(p.best!.rulesQuote!, /below \$55,000/);
    assert.equal(p.aiDegraded, false);
  } finally { restore(); }
}));

test("demo: Houston hurricane → Polymarket Texas landfall, link only", () => withKey(async () => {
  const restore = stubFetch({ poly: houstonPoly, gemini: { parse: { summary: "A hurricane hits Houston between Oct 28 and Nov 2, 2026", category: "weather", subject: "hurricane landfall Houston Texas", direction: "happens", threshold: null, unit: null, location: "Houston, Texas", deadline: "2026-11-02", windowStart: "2026-10-28", searchQueries: ["hurricane Houston landfall", "Texas hurricane landfall"], keyTerms: ["hurricane", "landfall", "texas", "houston"], isBet: false },
    judge: (p) => ({ ratings: [{ index: idx(p, "Texas"), fit: "close", side: "YES", covered: "Pays if a hurricane makes landfall anywhere in Texas by Nov 30.", quote: null, gaps: ["Covers all of Texas through Nov 30, wider than your Houston trip."] }] }) } });
  try {
    const p = await plan({ worry: "I'm in Houston Oct 28–Nov 2, $1,200 at risk if a hurricane hits.", amountAtRisk: 1200 }, NOW);
    assert.equal(p.verdict, "hedge_elsewhere", p.headline); assert.equal(p.execute, null); assert.equal(p.best!.market.venue, "polymarket");
    assert.match(p.headline, /Best protection is on Polymarket at 3¢/); assert.match(p.headline, /polymarket\.com\/event\//);
    assert.ok(!p.alternatives.some((o) => /Carolina/.test(o.market.title) && o.fit !== "none"));
  } finally { restore(); }
}));

test("Polymarket best + decent World alternative → link plus 'buyable now through PayBox'", () => withKey(async () => {
  const restore = stubFetch({ poly: [polyEvent("btc-low", [{ q: "Will Bitcoin dip below $55,000 in 2026?", ask: 0.1, end: "2027-01-01T04:59:00Z" }])], gemini: { parse: btcParse,
    judge: (p) => ({ ratings: [{ index: idx(p, "dip below"), fit: "exact", side: "YES", covered: "x", quote: null, gaps: [] }, { index: idx(p, "B55K") >= 0 ? idx(p, "55,000 in 2026") : idx(p, "[world]"), fit: "close", side: "YES", covered: "y", quote: null, gaps: [] }] }) } });
  try {
    const p = await plan({ worry: BTC_WORRY, amountAtRisk: 100, candidates: [btcEvent.markets[0]] }, NOW);
    assert.equal(p.verdict, "hedge_elsewhere", p.headline); assert.match(p.headline, /Buyable now through PayBox/);
    assert.equal(p.buyableNow!.market.venue, "world"); assert.equal(p.execute!.tool, "world_buy_outcome");
  } finally { restore(); }
}));

test("demo: rain at Lagos wedding → no good hedge", () => withKey(async () => {
  const restore = stubFetch({ poly: [polyEvent("la-rain", [{ q: "Will it rain in Los Angeles on December 12?", ask: 0.1 }])], gemini: { parse: { summary: "Rain in Lagos on Dec 12, 2026", category: "weather", subject: "rain Lagos", direction: "happens", threshold: null, unit: null, location: "Lagos", deadline: "2026-12-12", windowStart: "2026-12-12", searchQueries: ["Lagos rain"], keyTerms: ["rain", "lagos"], isBet: false },
    judge: () => ({ ratings: [{ index: 0, fit: "none", side: "YES", covered: "Rain in Los Angeles.", quote: null, gaps: ["Wrong city."] }] }) } });
  try { const p = await plan({ worry: "Rain at my outdoor wedding in Lagos on Dec 12.", amountAtRisk: 300 }, NOW); assert.equal(p.verdict, "no_good_hedge"); assert.equal(p.execute, null); }
  finally { restore(); }
}));

test("Knicks bet → that's a bet, not a hedge", async () => {
  assert.ok(isBetText("I think the Knicks will win, put money on it")); assert.ok(!isBetText(BTC_WORRY));
  const restore = stubFetch({ poly: [] });
  try { const p = await plan({ worry: "I think the Knicks will win, put money on it", amountAtRisk: 50 }, NOW);
    assert.equal(p.verdict, "not_a_hedge"); assert.match(p.headline, /^That's a bet, not a hedge/); assert.equal(p.execute, null);
    assert.match((await preview("I think the Knicks will win, put money on it")).next[0]!, /bet, not a hedge/);
  } finally { restore(); }
});

test("Fed hikes twice vs 'exactly 2 hikes' bucket → loose, shown with gaps first", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: { summary: "The Fed hikes at least twice in 2026", category: "rates", subject: "fed rate hikes", direction: "happens", threshold: 2, unit: "hikes", location: null, deadline: "2026-12-31", windowStart: null, searchQueries: ["fed hike"], keyTerms: ["fed", "hike", "fomc"], isBet: false },
    judge: () => ({ ratings: [{ index: 0, fit: "close", side: "YES", covered: "Pays on exactly two hikes.", quote: null, gaps: [] }] }) } });
  try { const p = await plan({ worry: "If the Fed hikes twice this year my variable loan gets expensive.", amountAtRisk: 500, candidates: [fedExactly2] }, NOW);
    assert.equal(p.verdict, "hedge", p.headline); assert.equal(p.best!.fit, "loose"); assert.match(p.headline, /^Loose fit, read the gaps first: .*Partial cover/); assert.match(p.headline, /Partial hedge/);
  } finally { restore(); }
}));

test("liquidity cap: only $X of cover available at this price", () => withKey(async () => {
  const thin = { ...btcEvent.markets[0], yesAskQty: 300 };
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: () => ({ ratings: [{ index: 0, fit: "exact", side: "YES", covered: "x", quote: null, gaps: [] }] }) } });
  try { const p = await plan({ worry: BTC_WORRY, amountAtRisk: 1000, candidates: [thin] }, NOW);
    assert.equal(p.best!.cost!.shares, 300); assert.ok(p.best!.cost!.liquidityCapped); assert.match(p.best!.warnings.join(" "), /Only \$300\.00 of cover is available at this price/);
    assert.equal(p.execute!.shares, 300);
  } finally { restore(); }
}));

test("expensive cover: warning at ≥50¢, declined at ≥70¢", () => withKey(async () => {
  const mk = (ask: number) => ({ ...btcEvent.markets[0], yesAsk: ask });
  const restore = stubFetch({ poly: [], gemini: { parse: btcParse, judge: () => ({ ratings: [{ index: 0, fit: "exact", side: "YES", covered: "x", quote: null, gaps: [] }] }) } });
  try {
    const a = await plan({ worry: BTC_WORRY, amountAtRisk: 100, candidates: [mk(0.55)] }, NOW);
    assert.equal(a.verdict, "hedge"); assert.match(a.best!.warnings.join(" "), /market thinks this is likely/);
    const b = await plan({ worry: BTC_WORRY, amountAtRisk: 100, candidates: [mk(0.75)] }, NOW);
    assert.equal(b.verdict, "no_good_hedge"); assert.match(b.headline, /protects almost nothing/);
  } finally { restore(); }
}));

test("AI unavailable → keyword fallback is never buyable and flags aiDegraded", async () => {
  const restore = stubFetch({ poly: [] });
  try { const p = await plan({ worry: BTC_WORRY, amountAtRisk: 100, candidates: [btcEvent] }, NOW); assert.equal(p.verdict, "no_good_hedge"); assert.ok(p.aiDegraded); }
  finally { restore(); }
});

test("preview tells the agent to fetch rules with world_get_events / world_get_markets", () => withKey(async () => {
  const restore = stubFetch({ gemini: { parse: btcParse } });
  try { const p = await preview(BTC_WORRY); assert.match(p.next.join(" "), /world_get_events\(ticker\) or world_get_markets\(ticker\)/); assert.deepEqual(p.worldSearch, btcParse.searchQueries); }
  finally { restore(); }
}));

test("input validation", async () => { await assert.rejects(plan({ worry: "x", amountAtRisk: -1 })); await assert.rejects(plan({ worry: " ", amountAtRisk: 5 })); });

test("judge prompt: wider area/window that still pays = close, narrower = loose", () => withKey(async () => {
  let sys = "";
  const restore = stubFetch({ poly: houstonPoly, gemini: { parse: { summary: "hurricane hits Houston", category: "weather", subject: "hurricane landfall Houston Texas", direction: "happens", threshold: null, unit: null, location: "Houston", deadline: "2026-11-02", windowStart: "2026-10-28", searchQueries: ["Texas hurricane landfall"], keyTerms: ["hurricane", "landfall", "texas", "houston"], isBet: false },
    judge: (_p, s) => { sys = s; return { ratings: [] }; } } });
  try { await plan({ worry: "I'm in Houston Oct 28–Nov 2, $1,200 at risk if a hurricane hits.", amountAtRisk: 1200 }, NOW);
    assert.match(sys, /WIDER than the worry but still pays whenever the worry happens[\s\S]*?is close/); assert.match(sys, /NARROWER than the worry[\s\S]*?is loose/);
  } finally { restore(); }
}));

test("partial-cover gap text is generic", () => withKey(async () => {
  const restore = stubFetch({ poly: [], gemini: { parse: { summary: "BTC between 50k and 60k? no", category: "crypto", subject: "bitcoin", direction: "below", threshold: 74000, unit: null, location: null, deadline: "2026-12-31", windowStart: null, searchQueries: ["btc"], keyTerms: ["bitcoin"], isBet: false },
    judge: () => ({ ratings: [{ index: 0, fit: "exact", side: "YES", covered: "x", quote: null, gaps: [] }] }) } });
  try { const p = await plan({ worry: "My BTC savings get hurt if bitcoin drops under 74k", amountAtRisk: 100, candidates: [{ ticker: "WXBTC-R", title: "Bitcoin between $70,000 and $74,000 on Dec 31?", rules: "Resolves Yes if the close is in range.", yesAsk: 0.1, noAsk: 0.91, closeTime: "2027-01-01T00:00:00Z" }] }, NOW);
    const g = (p.best ?? p.alternatives[0])!.whatsNotCovered.join(" "); assert.match(g, /Results outside this bucket aren't covered/); assert.doesNotMatch(g, /hikes/);
  } finally { restore(); }
}));

test("Polymarket search always includes a core-event query from the key terms", () => withKey(async () => {
  const seen: string[] = []; const real = globalThis.fetch;
  const restore = stubFetch({ poly: [], gemini: { parse: { summary: "s", category: "weather", subject: "Hurricane Houston", direction: "happens", threshold: null, unit: null, location: "Houston", deadline: null, windowStart: null, searchQueries: ["hurricane Houston landfall"], keyTerms: ["hurricane", "landfall", "houston"], isBet: false }, judge: () => ({ ratings: [] }) } });
  const stubbed = globalThis.fetch; globalThis.fetch = (async (u: any, i: any) => { seen.push(String(u)); return stubbed(u, i); }) as any;
  try { await plan({ worry: "I'm in Houston, worried a hurricane hits", amountAtRisk: 100 }, NOW); assert.ok(seen.some((u) => u.includes("q=hurricane%20landfall&"))); }
  finally { globalThis.fetch = real; restore(); }
}));
