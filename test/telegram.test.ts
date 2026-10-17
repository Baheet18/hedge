import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, card, handleUpdate, tgSecret } from "../src/telegram.js";
import { createApp } from "../src/app.js";

test("amount parsing: cover $100, thresholds aren't amounts, default 100", () => {
  assert.deepEqual(parseAmount("Bitcoin drops below $55k, cover $100"), { worry: "Bitcoin drops below $55k", amount: 100 });
  assert.equal(parseAmount("Hurricane hits Houston on my trip, cover $200").amount, 200);
  assert.equal(parseAmount("Bitcoin drops below $55k").amount, 100);
  assert.equal(parseAmount("Bitcoin drops below $55k").worry, "Bitcoin drops below $55k");
  assert.equal(parseAmount("Rain at my Lagos wedding, I'd lose 1,500 dollars").amount, 1500);
  assert.equal(parseAmount("Naira passes 2000, cover 2k").amount, 2000);
});

const poly = { verdict: "hedge_elsewhere", headline: "Best protection…", match: { venue: "polymarket", title: "Will a hurricane make landfall in Texas by November 30, 2026?", side: "YES", fit: "close", price: 0.09, costToCover: 11.02, payout: 115, coveragePct: 57.5, url: "https://polymarket.com/event/x", whatsNotCovered: ["Wider area than Houston", "<b>tag</b>"], warnings: ["Polymarket depth: only about 115 shares"] } };
test("card: Polymarket match has price, cost, payout, coverage, gaps (escaped) and an Open on Polymarket button", () => {
  const c = card(poly, 200);
  for (const s of ["Polymarket", "YES", "9¢", "$11.02", "$115.00", "57.5%", "Fit: <b>close</b>", "• Wider area than Houston", "&lt;b&gt;tag", "depth"]) assert.ok(c.text.includes(s), s);
  assert.deepEqual(c.buttons, [[{ text: "Open on Polymarket", url: "https://polymarket.com/event/x" }]]);
});
test("card: World match links to PayBox; no good hedge and bets are friendly", () => {
  const w = card({ ...poly, match: { ...poly.match, venue: "world", url: null, warnings: ["Size not checked: run world_orderbook"] } }, 200);
  assert.equal(w.buttons[0][0].text, "Buy on World via PayBox"); assert.match(w.text, /size unverified/); assert.doesNotMatch(w.text, /57.5%/);
  const n = card({ verdict: "no_good_hedge", headline: "No good hedge: no listed market pays when this happens. World wasn't searched yet: run world_search x", match: null }, 300);
  assert.match(n.text, /No good hedge/); assert.doesNotMatch(n.text, /world_search/); assert.match(n.text, /Polymarket/);
  const b = card({ verdict: "not_a_hedge", match: null }, 50); assert.match(b.text, /bet, not a hedge/); assert.match(b.text, /non-refundable/);
});
test("handleUpdate: /start explains with examples; worries send typing first", async () => {
  const sent: any[] = []; const send = async (m: string, b: any) => { sent.push([m, b]); return {}; };
  await handleUpdate({ message: { chat: { id: 1 }, text: "/start" } }, send as any);
  assert.equal(sent[0][0], "sendMessage"); assert.match(sent[0][1].text, /Bitcoin drops below \$55k, cover \$100/);
  await handleUpdate({ message: { chat: { id: 1 }, text: "I think the Lakers win tonight, put $50 on it" } }, send as any);
  assert.equal(sent[1][0], "sendChatAction"); assert.match(sent[2][1].text, /bet, not a hedge/);
});
test("webhook rejects a wrong secret", async () => {
  process.env.HEDGE_TG_BOT_TOKEN = "123:abc";
  try {
    const r = await createApp().request("/api/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "nope" }, body: "{}" }); assert.equal(r.status, 401);
    assert.equal(tgSecret("123:abc").length, 48);
  } finally { delete process.env.HEDGE_TG_BOT_TOKEN; }
});
