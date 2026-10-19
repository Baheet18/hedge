// Oct 19: use each Polymarket market's own taker fee (Gamma feesEnabled + feeSchedule), not a flat estimate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { costToCover, costFromBook, feeFor, feePerShare } from "../src/core/math.js";
import { polymarketFee } from "../src/core/universe.js";
import { freeMatch } from "../src/core/plan.js";
import { card } from "../src/telegram.js";
import { stubFetch } from "./stub.js";

const crypto = { feesEnabled: true, feeType: "crypto_fees_v2", feeSchedule: { exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 } }; // live "dip to $70k in October" fields
test("fee fields: feeSchedule → real rate; feesEnabled false → none; missing → unknown (never a guess)", () => {
  assert.deepEqual(polymarketFee(crypto), { rate: 0.07, exponent: 1, source: "polymarket crypto_fees_v2" });
  assert.equal(polymarketFee({ feesEnabled: false, feeSchedule: null }), "none");
  assert.equal(polymarketFee({}), "unknown"); assert.equal(polymarketFee({ feesEnabled: true }), "unknown");
  assert.equal(polymarketFee({ feesEnabled: true, feeSchedule: { rate: 0, exponent: 1 } }), "none");
});
test("fee formula: shares × rate × (p(1−p))^exponent, matching Polymarket's table (100 shares at 10¢ crypto = $0.63)", () => {
  const m = polymarketFee(crypto);
  assert.equal(Math.round(100 * feeFor(0.1, m) * 100) / 100, 0.63); assert.equal(Math.round(100 * feeFor(0.5, m) * 100) / 100, 1.75);
  assert.equal(Math.round(100 * feeFor(0.5, polymarketFee({ feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 2 } })) * 10000) / 10000, 0.3125);
  assert.equal(feeFor(0.3, "none"), 0); assert.equal(feeFor(0.3, "unknown"), 0); assert.equal(feeFor(0.3), feePerShare(0.3), "World keeps the estimate");
  const c = costToCover(0.06, 10000, null, null, m); assert.equal(c.fees, Math.round(10000 * 0.07 * 0.06 * 0.94 * 100) / 100); assert.equal(c.feeSource, "polymarket crypto_fees_v2");
  assert.equal(costToCover(0.06, 10000, null, null, "none").cost, 600); assert.equal(costToCover(0.06, 10000, null, null, "unknown").feeSource, "unknown");
  assert.equal(costFromBook([{ p: 0.06, s: 20000 }], 10000, null, 0.7, "none")!.cost, 600);
});
test("card: fees shown only when above zero; 'fees not included' when the lookup failed; World says est.", () => {
  const base = { venue: "polymarket", title: "Will Bitcoin dip to $70,000 in October?", side: "YES", fit: "exact", price: 0.06, bestPrice: 0.06, priceText: "6¢", payout: 10000, coveragePct: 100, url: "u", whatsNotCovered: [], warnings: [] };
  const t = (m: object) => card({ verdict: "hedge_elsewhere", match: { ...base, ...m } }, 10000).text;
  assert.match(t({ costToCover: 639.48, fees: 39.48, feeSource: "polymarket crypto_fees_v2" }), /Cost <b>\$639\.48<\/b> \(incl\. ~\$39\.48 fees\) →/);
  assert.match(t({ costToCover: 600, fees: 0, feeSource: "none" }), /Cost <b>\$600\.00<\/b> → pays/);
  assert.match(t({ costToCover: 600, fees: 0, feeSource: "unknown" }), /Cost <b>\$600\.00<\/b> \(fees not included\) →/);
  assert.match(t({ venue: "world", costToCover: 640, fees: 40, feeSource: "estimate" }), /\(incl\. ~\$40\.00 est\. fees\)/);
});
const ev = (extra: object) => ({ slug: "btc-oct", title: "btc", endDate: "2026-11-01T04:00:00Z", markets: [{ id: "x", slug: "will-bitcoin-dip-to-70k-in-october-2026", question: "Will Bitcoin dip to $70,000 in October?", description: "Bitcoin price dip below $70,000 per Binance.", bestAsk: 0.06, bestBid: 0.05, outcomePrices: "[\"0.06\",\"0.94\"]", endDate: "2026-11-01T04:00:00Z", active: true, closed: false, ...extra }] });
const parse = { summary: "Bitcoin falls below $70,000 in October", category: "crypto", subject: "bitcoin price", direction: "below", threshold: 70000, unit: "USD", location: null, deadline: "2026-10-31", windowStart: null, searchQueries: ["bitcoin october"], keyTerms: ["bitcoin", "70000"], isBet: false };
test("free match end to end: the market's own fee flows into cost (crypto 7%), zero-fee markets cost price only, unknown says so", () => withKey(async () => {
  for (const [extra, cost, src] of [[crypto, Math.round((600 + 10000 * 0.07 * 0.06 * 0.94) * 100) / 100, "polymarket crypto_fees_v2"], [{ feesEnabled: false }, 600, "none"], [{}, 600, "unknown"]] as const) {
    const restore = stubFetch({ poly: [ev(extra)], gemini: { parse, judge: () => ({ ratings: [{ index: 0, fit: "exact", side: "YES", covered: "Pays on a dip.", quote: null, gaps: [] }] }) } });
    try { const f: any = await freeMatch({ worry: "Bitcoin drops below $70k this month, cover $10,000", amountAtRisk: 10000 }, new Date("2026-10-19T13:00:00Z"));
      assert.equal(f.match.costToCover, cost, JSON.stringify(f.match)); assert.equal(f.match.feeSource, src); }
    finally { restore(); }
  }
}));
async function withKey(fn: () => Promise<void>) { process.env.GEMINI_API_KEY = "k"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } }
