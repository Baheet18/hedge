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
    const s = JSON.stringify(r); assert.doesNotMatch(s, /rulesQuote|whatsNotCovered|outcomeMint|YESb55kMint/);
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
