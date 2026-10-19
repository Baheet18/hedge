// Quality fixes (Oct 19): ask for a timeframe, never invent dates, views vs bets, which game, one fit rating, gap/grammar tidy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, question, readQuestion, timePhrase, card, moneyIn } from "../src/telegram.js";
import { plan, freeMatch, noHedgeHeadline, type Option } from "../src/core/plan.js";
import { codeChecks, dedupeGaps, fitLabel } from "../src/core/fit.js";
import { ground, looksLikeView, rulesParse, timeframeIn } from "../src/core/worry.js";
import type { Candidate } from "../src/core/types.js";
import { btcEvent } from "./fixtures/world.js";
import { stubFetch, polyEvent } from "./stub.js";

const NOW = new Date("2026-10-17T11:00:00Z");
const withKey = async (fn: () => Promise<void>) => { process.env.GEMINI_API_KEY = "k"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } };
const rate = (p: string, f: (line: string) => string) => ({ ratings: p.split("\n").filter((l) => /^#\d+ /.test(l)).map((l) => ({ index: Number(l.slice(1, l.indexOf(" "))), fit: f(l), side: "YES", covered: "Pays if it happens.", quote: null, gaps: [] })) });
/** Fake Telegram: records calls; Telegram hands back message text without HTML tags. */
const bot = () => { const sent: any[] = []; const send = async (m: string, b: any) => { sent.push([m, b]); return {}; }; const msgs = () => sent.filter((s) => s[0] === "sendMessage").map((s) => s[1]); return { sent, send: send as any, msgs }; };
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tap = (q: any, data: string) => ({ callback_query: { id: "cb1", data, message: { message_id: 9, chat: { id: 7 }, text: plain(q.text) } } });
const say = (text: string, replyTo?: any) => ({ message: { chat: { id: 7 }, text, ...(replyTo ? { reply_to_message: { from: { is_bot: true }, text: plain(replyTo.text) } } : {}) } });

const btcParse = { summary: "Bitcoin crashes", category: "crypto", subject: "bitcoin price", direction: "below", threshold: null, unit: null, location: null, deadline: null, windowStart: null, searchQueries: ["bitcoin"], keyTerms: ["bitcoin", "btc"], isBet: false };
const btcParseDec31 = { ...btcParse, deadline: "2026-12-31" }; // an AI that invents Dec 31
const btcPoly = polyEvent("btc", [{ q: "Will Bitcoin dip to $80,000 in October?", desc: "Bitcoin price dip", ask: 0.2, end: "2026-11-01T03:59:00Z" }]);

test("fix 1: no timeframe → bot asks 'By when?' (no search), then continues with the tapped answer", () => withKey(async () => {
  let polyCalls = 0; const restore = stubFetch({ poly: [btcPoly], gemini: { parse: btcParse, judge: (p) => { polyCalls++; return rate(p, () => "close"); } } });
  try {
    const b = bot(); await handleUpdate(say("I'm worried Bitcoin crashes"), b.send, NOW);
    const q = b.msgs()[0]; assert.match(q.text, /By when\?/); assert.match(q.text, /This week, this month, by end of year\?/); assert.equal(polyCalls, 0, "no search before the answer");
    assert.deepEqual(q.reply_markup.inline_keyboard.flat().map((x: any) => x.callback_data), ["t:week", "t:month", "t:year", "t:any"]);
    await handleUpdate(tap(q, "t:month"), b.send, NOW);
    assert.ok(b.sent.some((s) => s[0] === "answerCallbackQuery") && b.sent.some((s) => s[0] === "editMessageReplyMarkup"));
    const c = b.msgs()[1]; assert.match(c.text, /Decent hedge/); assert.match(c.text, /Bitcoin dip to \$80,000 in October/); assert.equal(polyCalls, 1);
    // A typed reply to the question works too
    const b2 = bot(); await handleUpdate(say("I'm worried Bitcoin crashes"), b2.send, NOW); await handleUpdate(say("by end of October", b2.msgs()[0]), b2.send, NOW);
    assert.match(b2.msgs()[1].text, /hedge<\/b>|hedge \(loose fit\)<\/b>/); assert.match(b2.msgs()[1].text, /Bitcoin dip/);
    // A plain typed answer right after the question (same warm instance) also continues
    const b3 = bot(); await handleUpdate(say("I'm worried Bitcoin crashes"), b3.send, NOW); await handleUpdate(say("this month"), b3.send, NOW);
    assert.match(b3.msgs()[1].text, /Bitcoin dip/);
    // A bare date with no question pending: ask which worry
    const b4 = bot(); await handleUpdate({ message: { chat: { id: 8 }, text: "by March" } }, b4.send, NOW); assert.match(b4.msgs()[0].text, /Which worry is that for\?/);
  } finally { restore(); }
}));

test("fix 1: timeframe phrases become explicit dates; worries with a time aren't asked", () => {
  assert.equal(timePhrase("t:month", NOW), "this month (by Saturday, October 31, 2026)");
  assert.equal(timePhrase("t:week", NOW), "by Sunday, October 18, 2026 (this week)");
  assert.equal(timePhrase("t:year", NOW), "by December 31, 2026 (end of this year)");
  assert.equal(timePhrase("t:any", NOW), "(no end date)"); assert.equal(timePhrase("March", NOW), "by March"); assert.equal(timePhrase("idk", NOW), "(no end date)");
  for (const t of ["Bitcoin drops below $55k by end of year", "rain on Nov 14", "this month", "next Fed meeting", "in 3 weeks", "before 2027"]) assert.ok(timeframeIn(t), t);
  for (const t of ["I'm worried Bitcoin crashes", "Bitcoin may crash", "my Lakers bet", "Oil above $100 wrecks my business"]) assert.ok(!timeframeIn(t), t);
  const q = question("time", "Bitcoin crashes", 250, true); const r = readQuestion(plain(q.text))!;
  assert.deepEqual([r.ask, r.worry, r.amount, r.stated], ["time", "Bitcoin crashes", 250, true]);
});

test("fix 2: an AI end date the user didn't give is dropped and said plainly; scheduled events state the assumed date", () => withKey(async () => {
  const w = ground({ ...rulesParse("Oil above $100 wrecks my delivery business", NOW), deadline: "2026-12-31" });
  assert.equal(w.deadline, null); assert.match(w.assumptions![0]!, /didn't give a timeframe, so no end date was assumed/);
  const e = ground({ ...rulesParse("If my party loses the governor election I lose my contract", NOW), deadline: "2026-11-03" });
  assert.equal(e.deadline, "2026-11-03"); assert.match(e.assumptions![0]!, /assumed the event is decided by 3 Nov 2026/);
  assert.equal(ground({ ...rulesParse("BTC below 55k by December 31, 2026", NOW), deadline: "2026-12-31" }).deadline, "2026-12-31");
  assert.equal(rulesParse("BTC below 55k by December 31, 2026", NOW).deadline, "2026-12-31", "exact day after a month name");
  const restore = stubFetch({ poly: [btcPoly], gemini: { parse: btcParseDec31, judge: (p) => rate(p, () => "close") } });
  try { const p = await plan({ worry: "I hold BTC and lose if Bitcoin crashes", amountAtRisk: 100 }, NOW);
    assert.equal(p.worry.deadline, null); assert.match(p.headline, /Assumed: You didn't give a timeframe/);
    const f = await freeMatch({ worry: "I hold BTC and lose if Bitcoin crashes", amountAtRisk: 100 }, NOW);
    assert.match(f.worry.assumptions[0]!, /no end date was assumed/); assert.match(card(f, 100).text, /no end date was assumed/);
  } finally { restore(); }
}));

test("fix 3: a view with no stated loss → ask what you'd lose; 'just my view' → it's a view; a real loss continues", () => withKey(async () => {
  assert.ok(looksLikeView("the real estate market will crash")); assert.ok(looksLikeView("I think the real estate market will crash")); assert.ok(looksLikeView("Bitcoin will crash"));
  assert.ok(!looksLikeView("I'm worried Bitcoin crashes")); assert.ok(!looksLikeView("Bitcoin drops below $55k")); assert.ok(!looksLikeView("the real estate market will crash and I own a flat"));
  assert.ok(!looksLikeView("the market will crash", true), "a stated amount is exposure");
  const parse = { summary: "Real estate market crashes", category: "macro", subject: "real estate prices", direction: "happens", threshold: null, unit: null, location: null, deadline: null, windowStart: null, searchQueries: ["housing market crash"], keyTerms: ["housing", "home prices"], isBet: false };
  const restore = stubFetch({ poly: [], gemini: { parse, judge: (p) => rate(p, () => "none") } });
  try {
    const b = bot(); await handleUpdate(say("the real estate market will crash"), b.send, NOW);
    const q = b.msgs()[0]; assert.match(q.text, /What would you actually lose\?/); assert.match(q.text, /own the asset or property/);
    await handleUpdate(tap(q, "v:view"), b.send, NOW); assert.match(b.msgs()[1].text, /That's a view, not a hedge/);
    const b2 = bot(); await handleUpdate(say("the real estate market will crash"), b2.send, NOW);
    await handleUpdate(say("I own a $200k flat in Lagos", b2.msgs()[0]), b2.send, NOW);
    const q2 = b2.msgs()[1]; assert.match(q2.text, /By when\?/, "loss answered → next it asks the timeframe"); assert.match(plain(q2.text), /Worry: the real estate market will crash\. I own a \$200k flat in Lagos/); assert.match(q2.text, /Amount: \$200000\.00\n|Amount: \$200000\.00$/);
    assert.equal(moneyIn("about 5,000 dollars"), 5000); assert.equal(moneyIn("$1.5m house"), 1.5e6);
  } finally { restore(); }
}));

test("fix 4: an undated sports bet with several fitting markets → 'Which game?'; picking one shows its card", () => withKey(async () => {
  const parse = { summary: "The Lakers lose the game my bet is on", category: "sports", subject: "lakers game", direction: "happens", threshold: null, unit: null, location: null, deadline: null, windowStart: null, searchQueries: ["lakers"], keyTerms: ["lakers"], isBet: false };
  const ev = polyEvent("nba", [{ q: "Lakers vs. Celtics", desc: "Lakers game", ask: 0.45, end: "2026-10-22T03:00:00Z" }, { q: "Lakers vs. Warriors", desc: "Lakers game", ask: 0.4, end: "2026-10-25T03:00:00Z" }, { q: "Lakers vs. Suns", desc: "Lakers game", ask: 0.42, end: "2026-10-28T03:00:00Z" }]);
  const restore = stubFetch({ poly: [ev], gemini: { parse, judge: (p) => rate(p, (l) => (/after the game:|the game: Lakers vs\. Warriors/.test(p) && !/Warriors/.test(l) ? "none" : "close")) } });
  try {
    const b = bot(); await handleUpdate(say("I'm worried about my Lakers bet, I'd lose $50"), b.send, NOW);
    const q = b.msgs()[0]; assert.match(q.text, /Which game\?/); assert.match(q.text, /1\. Lakers vs\. /); assert.match(q.text, /2\. Lakers vs\. /);
    assert.ok(q.reply_markup.inline_keyboard.length >= 2 && q.reply_markup.inline_keyboard[0][0].callback_data === "g:1");
    const n = q.reply_markup.inline_keyboard.findIndex((r: any) => /Warriors/.test(r[0].text)) + 1;
    await handleUpdate(tap(q, `g:${n}`), b.send, NOW);
    const c = b.msgs()[1]; assert.doesNotMatch(c.text, /Which game/); assert.match(c.text, /Lakers vs\. Warriors/); assert.match(c.text, /\$50\.00/);
  } finally { restore(); }
}));

test("fix 5: one fit label everywhere; the paid plan reuses the free match's rating for the same market", () => withKey(async () => {
  assert.deepEqual(["exact", "close", "loose"].map((f) => fitLabel(f as any).title), ["Good hedge", "Decent hedge", "Partial hedge (loose fit)"]);
  const btcP = { summary: "Bitcoin falls below $55,000 before the end of 2026", category: "crypto", subject: "bitcoin price", direction: "below", threshold: 55000, unit: "USD", location: null, deadline: "2026-12-31", windowStart: null, searchQueries: ["bitcoin below"], keyTerms: ["bitcoin", "btc", "below", "55,000"], isBet: false };
  // A judge that wobbles with context: alone it says close; with more markets in the prompt it says loose.
  const judge = (p: string) => { const n = p.split("\n").filter((l) => /^#\d+ /.test(l)).length; return rate(p, () => (n > 2 ? "loose" : "close")); };
  const restore = stubFetch({ poly: [polyEvent("btc", [{ q: "Will Bitcoin dip to $55,000 by December 31, 2026?", desc: "bitcoin below 55,000", ask: 0.15, end: "2026-12-31T23:59:00Z" }])], gemini: { parse: btcP, judge } });
  const prev = process.env.HEDGE_NO_CACHE; delete process.env.HEDGE_NO_CACHE;
  try {
    const worry = "I hold BTC and lose if it falls below $55k by end of 2026, fit consistency test";
    const f = await freeMatch({ worry, amountAtRisk: 100, candidates: [btcEvent] }, NOW);
    const p = await plan({ worry, amountAtRisk: 100, candidates: [btcEvent] }, NOW);
    const id = f.match!.marketId; const inPlan = [p.best, p.buyableNow, ...p.alternatives].find((o) => o?.market.marketId === id)!;
    assert.equal(inPlan.fit, f.match!.fit, "same market, same fit in free and paid"); assert.equal(f.match!.fitLabel, fitLabel(inPlan.fit).title);
  } finally { process.env.HEDGE_NO_CACHE = prev; restore(); }
}));

const cand = (title: string): Candidate => ({ source: "reference", venue: "polymarket", marketId: title, title, rules: `Resolves Yes if ${title}`, closeTime: "2026-12-31T23:59:00Z", yesAsk: 0.1, noAsk: 0.9, yesBid: null, noBid: null, yesMint: null, noMint: null, url: "", sources: [], askQty: { yes: null, no: null } });
test("fix 6: one threshold line (AI duplicate dropped); 'no good hedge' reads as a sentence and isn't repeated", () => {
  const w = { ...rulesParse("Oil going above $100 by end of 2026 would wreck my delivery business", NOW), threshold: 100, direction: "above" as const };
  const r = codeChecks(w, cand("Will WTI crude oil close above $115 in 2026?"), { marketId: "x", fit: "close", side: "YES", covered: "", gaps: ["The market triggers at $115, not your $100 level.", "Settles on WTI futures, not the pump price."], quote: null, by: "ai" }, NOW);
  assert.equal(r.gaps.filter((g) => /115/.test(g)).length, 1, r.gaps.join("|")); assert.ok(r.gaps.some((g) => /pump price/.test(g)));
  assert.deepEqual(dedupeGaps(["Threshold: it pays from $115, not $100. A move between the two isn't covered.", "Threshold: it pays from $115, not $100. A move between the two isn't covered."]).length, 1);
  const o = { market: { title: "Will WTI hit $150?" }, fit: "loose", ratedBy: "ai", cost: { price: 0.004, feePerShare: 0, shares: 10 } } as unknown as Option;
  const h = noHedgeHeadline(o); assert.match(h, /^No good hedge: the closest market, "Will WTI hit \$150\?", is priced at 0\.4¢, below 1¢/); assert.doesNotMatch(h, /market it's/);
  assert.equal(noHedgeHeadline(undefined), "No good hedge: no listed market pays when this happens.");
  const c = card({ verdict: "no_good_hedge", headline: h, match: null }, 100);
  assert.equal(c.text.match(/No good hedge/g)!.length, 1, c.text); assert.match(c.text, /The closest market, "Will WTI hit \$150\?", is priced/);
});
