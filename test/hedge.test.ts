import { test } from "node:test";
import assert from "node:assert/strict";
import { costToCover, feePerShare } from "../src/core/math.js";
import { bestQuote, codeChecks, down, titleNumbers } from "../src/core/fit.js";
import { normalizeWorld, price } from "../src/core/universe.js";
import { rulesParse } from "../src/core/worry.js";
import type { Candidate, FitJudgement } from "../src/core/types.js";

delete process.env.GEMINI_API_KEY; // tests are offline + deterministic
const NOW = new Date("2026-10-16T12:00:00Z");
const worldNaira = { marketId: "WRLD-NGN-NOV26-2000", title: "USD/NGN above 2,000 on Nov 30, 2026?", closeTime: "2026-11-30T23:00:00Z",
  rules: "If the official CBN NFEM closing rate for USD/NGN is above 2,000 on November 30, 2026, then the market resolves to Yes. The source is the Central Bank of Nigeria website. Otherwise it resolves to No.",
  yesAsk: 0.18, noAsk: 0.84, accounts: { CASHmint111: { marketLedger: "L1", yesMint: "YESmint111", noMint: "NOmint111", isInitialized: true } } };
const cand = (o: Partial<Candidate> = {}): Candidate => ({ ...normalizeWorld(worldNaira)!, ...o });
const j = (o: Partial<FitJudgement> = {}): FitJudgement => ({ marketId: "x", fit: "exact", side: "YES", covered: "", gaps: [], quote: null, by: "ai", ...o });

test("cost math: C shares at p plus fee, payout C", () => {
  const c = costToCover(0.18, 500);
  assert.equal(c.shares, 500); assert.equal(c.payout, 500);
  assert.equal(c.feePerShare, feePerShare(0.18));
  assert.equal(c.cost, Math.round(500 * (0.18 + c.feePerShare) * 100) / 100);
  assert.equal(c.netIfHappens, Math.round((500 - c.cost) * 100) / 100);
  assert.equal(c.coverage, 1); assert.equal(c.capped, false);
});
test("cost math: maxCost caps spend and shrinks coverage", () => {
  const c = costToCover(0.4, 1000, 100);
  assert.ok(c.cost <= 100); assert.ok(c.capped); assert.ok(c.coverage < 0.25 && c.coverage > 0.2);
});
test("cost math: rejects bad prices", () => { assert.throws(() => costToCover(1, 10)); assert.throws(() => costToCover(0, 10)); assert.throws(() => costToCover(0.5, 0)); });
test("price parsing: probability, cents, atomic", () => {
  assert.equal(price(0.42), 0.42); assert.equal(price("42"), 0.42); assert.equal(price("42c"), 0.42); assert.equal(price(420000), 0.42); assert.equal(price("x"), null);
});
test("World catalog shape: mints from accounts map", () => {
  const c = normalizeWorld(worldNaira)!; assert.equal(c.yesMint, "YESmint111"); assert.equal(c.noMint, "NOmint111"); assert.equal(c.source, "world");
});
test("quote: AI quote kept only when verbatim in rules", () => {
  const c = cand(); const w = rulesParse("naira above 2000 before Dec", NOW);
  assert.match(bestQuote(w, c, "then the market resolves to Yes")!, /CBN NFEM closing rate/);
  const q = bestQuote(w, c, "pays out whenever the naira weakens"); // invented -> replaced by a real sentence
  assert.ok(q && c.rules.includes(q));
});
test("fit: timing gap downgrades when market closes before the worry window", () => {
  const w = { ...rulesParse("naira above 2000", NOW), deadline: "2026-12-31", direction: "above" as const, threshold: 2000 };
  const r = codeChecks(w, cand(), j(), NOW); assert.equal(r.fit, "close"); assert.match(r.gaps[0]!, /Timing/);
});
test("fit: higher threshold than the worry is a gap", () => {
  const w = { ...rulesParse("naira above 1800", NOW), deadline: "2026-11-30", direction: "above" as const, threshold: 1800 };
  const r = codeChecks(w, cand(), j(), NOW); assert.equal(r.fit, "loose"); assert.match(r.gaps[0]!, /Threshold/);
  assert.deepEqual(titleNumbers("BTC above $100k on Dec 31, 2026?"), [100000, 31]);
});
test("fit: closed market is none", () => { const r = codeChecks(rulesParse("x"), cand({ closeTime: "2026-01-01T00:00:00Z" }), j(), NOW); assert.equal(r.fit, "none"); });
test("down() floors at none", () => { assert.equal(down("exact", 2), "loose"); assert.equal(down("loose", 5), "none"); });
test("sentences: numbered lists stay attached", async () => {
  const { sentences } = await import("../src/core/fit.js");
  const s = sentences('This market will resolve to "Yes" if either of the following conditions is met: 1. GDP is negative for two quarters. 2. The NBER declares a recession.');
  assert.match(s[0]!, /conditions is met: 1\. GDP is negative/);
});
