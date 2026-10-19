// Oct 19 (9:22 test): card said "buy YES at 8.7¢" but $70.75 / 764 = 9.26¢; and real estate matched Dubai for a Lagos firm without saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { costFromBook, costToCover, feePerShare } from "../src/core/math.js";
import { freeMatch } from "../src/core/plan.js";
import { codeChecks } from "../src/core/fit.js";
import { needsPlace, placeGap, rulesParse } from "../src/core/worry.js";
import { handleUpdate, card } from "../src/telegram.js";
import type { Candidate } from "../src/core/types.js";
import { stubFetch } from "./stub.js";

const NOW = new Date("2026-10-19T08:22:00Z");
const withKey = async (fn: () => Promise<void>) => { process.env.GEMINI_API_KEY = "k"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } };
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("price: the 9:22 numbers — 8.7¢ × 764 + est. fees = $70.75, and the card says the fees out loud", () => {
  const c = costToCover(0.087, 10000, null, 764);
  assert.equal(c.cost, 70.75); assert.equal(c.shares, 764); assert.equal(c.fees, Math.round(764 * feePerShare(0.087) * 100) / 100);
  assert.ok(Math.abs(c.cost - (c.shares * c.price + c.fees)) < 0.01, "cost = shares × price + fees");
  const t = card({ verdict: "hedge_elsewhere", match: { venue: "polymarket", title: "Will the DFM Real Estate Index dip to 8,000 in 2026?", side: "YES", fit: "loose", price: 0.087, bestPrice: 0.087, priceText: "8.7¢", estFees: c.fees, costToCover: c.cost, payout: c.payout, coveragePct: 7.6, url: "u", whatsNotCovered: [], warnings: [] } }, 10000).text;
  assert.match(t, /buy <b>YES<\/b> at 8\.7¢/); assert.match(t, /Cost <b>\$70\.75<\/b> \(incl\. ~\$4\.2\d est\. fees\) → pays <b>\$764\.00<\/b>/);
});

test("price: walking the book gives the average fill (price), best ask (bestPrice) and cost = shares × (price + fee)", () => {
  const c = costFromBook([{ p: 0.09, s: 300 }, { p: 0.087, s: 764 }, { p: 0.1, s: 5000 }], 1000)!;
  assert.equal(c.shares, 1000); assert.equal(c.bestPrice, 0.087);
  assert.ok(Math.abs(c.price - (764 * 0.087 + 236 * 0.09) / 1000) < 1e-9, String(c.price));
  assert.ok(Math.abs(c.cost - c.shares * (c.price + c.feePerShare)) < 0.01); assert.equal(c.liquidityCapped, false);
  const thin = costFromBook([{ p: 0.087, s: 764 }, { p: 0.2, s: 1000 }], 10000)!; // 20¢ is far above the 8.7¢ best: stop there
  assert.equal(thin.shares, 764); assert.equal(thin.liquidityCapped, true); assert.equal(thin.price, 0.087);
  const capped = costFromBook([{ p: 0.1, s: 10000 }], 10000, 50)!; assert.ok(capped.cost <= 50 && capped.capped);
  assert.equal(costFromBook([], 100), null);
});

const dfm = { slug: "dfm", title: "DFM", endDate: "2027-01-01T00:00:00Z", markets: [{ id: "d", slug: "dfm-8000", question: "Will the DFM Real Estate Index dip to 8,000 in 2026?", description: "Resolves Yes if the Dubai Financial Market Real Estate Index trades at or below 8,000 in 2026.", bestAsk: 0.087, bestBid: 0.08, outcomePrices: "[\"0.087\",\"0.913\"]", clobTokenIds: "[\"TYES\",\"TNO\"]", endDate: "2027-01-01T00:00:00Z", active: true, closed: false }] };
const parse = { summary: "Real estate prices crash", category: "macro", subject: "real estate prices", direction: "happens", threshold: null, unit: null, location: "Lagos", deadline: "2026-12-31", windowStart: null, searchQueries: ["real estate index", "property prices"], keyTerms: ["real estate", "index"], isBet: false };
const judge = () => ({ ratings: [{ index: 0, fit: "close", side: "YES", covered: "Pays if the index dips.", quote: null, gaps: [] }] });
const book = (asks: Array<[string, string]>) => { const f = globalThis.fetch; globalThis.fetch = (async (u: any, i: any) => String(u).includes("clob.polymarket.com") ? new Response(JSON.stringify({ asks: asks.map(([price, size]) => ({ price, size })) })) : f(u, i)) as any; return () => { globalThis.fetch = f; }; };

test("price: free match + card quote the average fill when the cover walks the book; depth note matches", () => withKey(async () => {
  const restore = stubFetch({ poly: [dfm], gemini: { parse: { ...parse, location: null }, judge } }); const unbook = book([["0.087", "764"], ["0.095", "500"], ["0.11", "200"]]);
  try { const f: any = await freeMatch({ worry: "I own property and lose if real estate crashes by end of 2026", amountAtRisk: 10000 }, NOW);
    const m = f.match; assert.ok(m, f.headline); assert.equal(m.shares, 1464); assert.equal(m.bestPrice, 0.087);
    assert.ok(Math.abs(m.costToCover - m.shares * m.price - m.estFees) < 0.02, "cost = shares × avg price + fees");
    assert.match(m.priceText, /^~9\.\d¢ avg \(best 8\.7¢\)$/); assert.match(f.headline, /at ~9\.\d¢ avg \(best 8\.7¢\)/);
    assert.match(m.warnings.join(" "), /only about 1464 shares on the book from 8\.7¢ to 11¢, so \$1464\.00 of cover at ~9\.\d¢ avg/);
    const t = card(f, 10000).text; assert.match(t, /buy <b>YES<\/b> at ~9\.\d¢ avg \(best 8\.7¢\)/); assert.match(t, /incl\. ~\$\d+\.\d\d est\. fees/);
  } finally { unbook(); restore(); }
}));

const cand = (title: string, rules: string): Candidate => ({ source: "reference", venue: "polymarket", marketId: title, title, rules, closeTime: "2027-01-01T00:00:00Z", yesAsk: 0.1, noAsk: 0.9, yesBid: null, noBid: null, yesMint: null, noMint: null, url: "", sources: [], askQty: { yes: null, no: null } });
test("place: which worries need a place, and a market for another place says so plainly and is loose at best", () => {
  for (const t of ["I think the real estate market will crash", "a hurricane hits my house", "rain ruins my outdoor wedding", "I own a estate development firm and property prices crash"]) assert.ok(needsPlace(t), t);
  for (const t of ["I think the real estate market will crash. I own a firm, in Lagos", "a hurricane hits Houston", "Bitcoin crashes this month", "the Fed doesn't cut in December", "naira passes 2000", "property crash in Dubai", "real estate crash (no specific place)"]) assert.ok(!needsPlace(t), t);
  assert.ok(needsPlace("rain in October ruins my wedding"), "a month isn't a place");
  const w = { ...rulesParse("I own an estate development firm, real estate crashes, in Lagos", NOW), location: "Lagos" };
  assert.equal(placeGap(w, "Will the DFM Real Estate Index dip to 8,000 in 2026?"), "Tracks Dubai, your property is in Lagos.");
  assert.equal(placeGap(w, "Will Nigeria house prices fall in 2026?"), null, "a wider area that includes Lagos isn't a different place");
  assert.equal(placeGap(w, "Will home prices fall?"), null, "no place named: no claim");
  const r = codeChecks(w, cand("Will the DFM Real Estate Index dip to 8,000 in 2026?", "Dubai Financial Market index."), { marketId: "x", fit: "close", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.equal(r.fit, "loose"); assert.equal(r.gaps[0], "Tracks Dubai, your property is in Lagos.");
  const h = { ...rulesParse("a hurricane hits my house in Houston", NOW), location: "Houston" };
  assert.equal(placeGap(h, "Will a hurricane make landfall in Texas?"), null);
});

test("place: Telegram asks 'Where is it?' (after loss and amount, before timeframe), uses the reply, and the card names the mismatch", () => withKey(async () => {
  const restore = stubFetch({ poly: [dfm], gemini: { parse, judge } }); const unbook = book([["0.087", "20000"]]);
  try {
    const sent: any[] = []; const send = (async (m: string, b: any) => { sent.push([m, b]); return {}; }) as any; const msgs = () => sent.filter((s) => s[0] === "sendMessage").map((s) => s[1]);
    const say = (text: string, q?: any) => handleUpdate({ message: { chat: { id: 9 }, text, ...(q ? { reply_to_message: { from: { is_bot: true }, text: plain(q.text) } } : {}) } }, send, NOW);
    const tap = (q: any, data: string) => handleUpdate({ callback_query: { id: "c", data, message: { message_id: 2, chat: { id: 9 }, text: plain(q.text) } } }, send, NOW);
    await say("I think the real estate market will crash"); assert.match(msgs()[0].text, /What would you actually lose\?/);
    await say("I own an estate development firm", msgs()[0]); assert.match(msgs()[1].text, /How much would you lose\?/);
    await tap(msgs()[1], "a:10000"); const qp = msgs()[2]; assert.match(qp.text, /Where is it\?/); assert.match(qp.text, /e\.g\. Lagos, Dubai, Miami/);
    assert.equal(qp.reply_markup.inline_keyboard[0][0].callback_data, "p:none");
    await say("Lagos", qp); const qt = msgs()[3]; assert.match(qt.text, /By when\?/); assert.match(plain(qt.text), /Worry: .*firm, in Lagos/); assert.match(qt.text, /Amount: \$10000\.00/);
    await tap(qt, "t:year"); const c = msgs()[4].text as string;
    assert.match(c, /Tracks Dubai, your property is in Lagos\./); assert.match(c, /Partial hedge \(loose fit\)/);
    // Place already given: no "Where is it?"
    sent.length = 0; await say("I own a $300k house in Lagos and lose if property prices crash by end of 2026, cover $20,000");
    assert.doesNotMatch(msgs()[0].text, /Where is it\?|By when\?/);
    // Not tied to a place
    sent.length = 0; await say("I own rental property and lose if house prices crash, cover $5,000"); assert.match(msgs()[0].text, /Where is it\?/);
    await tap(msgs()[0], "p:none"); assert.match(msgs()[1].text, /By when\?/); assert.match(plain(msgs()[1].text), /\(no specific place\)/);
  } finally { unbook(); restore(); }
}));
