// Oct 19, 9:13 live test: tapping "End of year" got no reply. Taps never reached the webhook; plus the loss answer kept a silent $100.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, question, readQuestion, ensureWebhook, tgSecret } from "../src/telegram.js";
import { stubFetch, polyEvent } from "./stub.js";

const NOW = new Date("2026-10-19T08:13:00Z");
const withKey = async (fn: () => Promise<void>) => { process.env.GEMINI_API_KEY = "k"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } };
const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const bot = () => { const sent: any[] = []; const send = (async (m: string, b: any) => { sent.push([m, b]); return {}; }) as any; return { sent, send, msgs: () => sent.filter((s) => s[0] === "sendMessage").map((s) => s[1]) }; };
const say = (text: string, replyTo?: any) => ({ message: { chat: { id: 3 }, text, ...(replyTo ? { reply_to_message: { from: { is_bot: true }, text: plain(replyTo.text) } } : {}) } });
const tap = (q: any, data: string) => ({ callback_query: { id: "c", data, message: { message_id: 4, chat: { id: 3 }, text: plain(q.text) } } });
const parse = { summary: "Real estate prices crash", category: "macro", subject: "real estate prices", direction: "happens", threshold: null, unit: null, location: null, deadline: "2026-12-31", windowStart: null, searchQueries: ["housing market", "home prices"], keyTerms: ["home", "prices", "housing"], isBet: false };
const housing = polyEvent("housing", [{ q: "Will US home prices fall in 2026?", desc: "Resolves Yes if the Case-Shiller US home price index falls year over year for 2026.", ask: 0.2, end: "2027-02-28T00:00:00Z" }]);

test("live flow: real estate view → 'I own a estate development firm' → asks how much → End of year tap → a card or an honest no good hedge", () => withKey(async () => {
  const restore = stubFetch({ poly: [housing], gemini: { parse, judge: () => ({ ratings: [{ index: 0, fit: "loose", side: "YES", covered: "Pays if US home prices fall in 2026.", quote: null, gaps: ["US index, not your local market."] }] }) } });
  try {
    const b = bot();
    await handleUpdate(say("I think the real estate market will crash"), b.send, NOW);
    const q1 = b.msgs()[0]; assert.match(q1.text, /What would you actually lose\?/);
    await handleUpdate(say("I own a estate development firm", q1), b.send, NOW);
    const q2 = b.msgs()[1]; assert.match(q2.text, /How much would you lose\?/, "no amount in the answer → ask, don't keep $100 quietly");
    assert.match(plain(q2.text), /Worry: I think the real estate market will crash\. I own a estate development firm/);
    await handleUpdate(tap(q2, "a:100000"), b.send, NOW);
    const qp = b.msgs()[2]; assert.match(qp.text, /Where is it\?/, "real estate with no place → ask where (after loss and amount)");
    await handleUpdate(say("Lagos", qp), b.send, NOW);
    const q3 = b.msgs()[3]; assert.match(q3.text, /By when\?/); assert.match(plain(q3.text), /firm, in Lagos/); assert.match(q3.text, /Amount: \$100000\.00(\n|$)/);
    await handleUpdate(tap(q3, "t:year"), b.send, NOW);
    assert.ok(b.sent.filter((s) => s[0] === "answerCallbackQuery").length === 2, "every tap is answered");
    const card = b.msgs()[4]; assert.ok(card, "the End of year tap gets a reply");
    assert.match(card.text, /hedge|No good hedge/i); assert.doesNotMatch(card.text, /By when|expired|error/i);
    assert.match(card.text, /\$100000\.00|No good hedge/);
    // Typed amount and Skip also work
    const b2 = bot(); await handleUpdate(say("I think the real estate market will crash"), b2.send, NOW);
    await handleUpdate(say("I own a estate development firm", b2.msgs()[0]), b2.send, NOW);
    await handleUpdate(say("about $250k", b2.msgs()[1]), b2.send, NOW); assert.match(b2.msgs()[2].text, /Where is it\?/); assert.match(b2.msgs()[2].text, /Amount: \$250000\.00(\n|$)/);
    const b3 = bot(); await handleUpdate(say("I think the real estate market will crash"), b3.send, NOW);
    await handleUpdate(say("I own a estate development firm", b3.msgs()[0]), b3.send, NOW);
    await handleUpdate(tap(b3.msgs()[1], "a:skip"), b3.send, NOW); assert.match(b3.msgs()[2].text, /Where is it\?/); assert.match(b3.msgs()[2].text, /Amount: \$100\.00(\n|$)/);
    await handleUpdate(say("lots", b3.msgs()[1]), b3.send, NOW); assert.match(b3.msgs()[3].text, /couldn't read an amount/);
  } finally { restore(); }
}));

test("a worry that spans two lines is read back whole; an unreadable tapped message gets a reply, not silence", async () => {
  const q = readQuestion("⏳ By when?\nThis week...\n\nWorry: I think the real estate market will crash.\nI own a estate development firm\nAmount: $100.00 (default; say \"cover $X\" to change)")!;
  assert.equal(q.worry, "I think the real estate market will crash. I own a estate development firm"); assert.equal(q.ask, "time"); assert.equal(q.stated, false);
  assert.equal(readQuestion(plain(question("time", "a\nb", 5, true).text))!.worry, "a b");
  const b = bot(); await handleUpdate({ callback_query: { id: "z", data: "t:year", message: { message_id: 1, chat: { id: 3 }, text: "some old message" } } }, b.send, NOW);
  assert.equal(b.sent[0][0], "answerCallbackQuery"); assert.match(b.msgs()[0].text, /expired/);
});

test("ensureWebhook: re-registers the same URL + secret with callback_query when Telegram's allowed_updates omits it", async () => {
  const run = async (allowed: string[]) => { const calls: any[] = []; const call = (async (m: string, b: any) => { calls.push([m, b]); return m === "getWebhookInfo" ? { ok: true, result: { url: "https://hedge-paybox.vercel.app/api/telegram", allowed_updates: allowed, pending_update_count: 0 } } : { ok: true }; }) as any;
    const mod = await import(`../src/telegram.js?x=${allowed.join("-") || "none"}`); await mod.ensureWebhook("123:abc", call); return calls; };
  const fixed = await run(["message"]);
  assert.deepEqual(fixed[1], ["setWebhook", { url: "https://hedge-paybox.vercel.app/api/telegram", secret_token: tgSecret("123:abc"), allowed_updates: ["message", "edited_message", "callback_query"] }]);
  assert.equal((await run([])).length, 1, "empty = Telegram's default (includes callback_query): no change");
  assert.equal((await run(["message", "callback_query"])).length, 1);
  assert.equal(await ensureWebhook(""), null, "no token: nothing");
});
