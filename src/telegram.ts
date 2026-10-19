// Standalone Hedge Telegram bot (webhook). Free match only, no x402. World data isn't public server-side,
// so standalone matches come from Polymarket; World buys go through an agent with PayBox.
// Follow-up questions (timeframe, what you'd lose, which game) keep no server state: the pending worry and amount are written
// into the question message itself, and come back on a button tap (callback_query.message) or a reply (reply_to_message).
// A per-chat in-memory note covers a plain typed answer while the same serverless instance is warm.
import { createHash } from "node:crypto";
import { plan, freeView, type Plan } from "./core/plan.js";
import { fitLabel } from "./core/fit.js";
import { understand, timeframeIn, looksLikeView, SPORTS } from "./core/worry.js";

const API = "https://api.telegram.org";
export const tgToken = () => process.env.HEDGE_TG_BOT_TOKEN || "";
/** Webhook secret derived from the token, so no extra env var is needed. */
export const tgSecret = (token = tgToken()) => createHash("sha256").update(`hedge-webhook:${token}`).digest("hex").slice(0, 48);

export async function tg(method: string, body: object, token = tgToken()) {
  const r = await fetch(`${API}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Amount at risk: "cover $100", "insure 200", "$300 at risk"; default $100. Thresholds like "$55k" are not amounts. */
const AMOUNT = /[,;.]?\s*\b(?:cover|insure|protect|hedge|risking|at risk of|i(?:'d| would)? lose|lose)\s+(?:me\s+)?(?:up to\s+)?\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:usd|dollars)?\b/i;
const matchAmount = (text: string) => AMOUNT.exec(text) ?? /[,;]\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:at risk)?\s*$/i.exec(text);
/** True when the message names the amount at risk (otherwise parseAmount's $100 is a default). */
export const amountStated = (text: string) => !!matchAmount(text);
export function parseAmount(text: string): { worry: string; amount: number } {
  const m = matchAmount(text);
  if (!m) return { worry: text.trim(), amount: 100 };
  const n = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return { worry: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim().replace(/[,;\s]+$/, ""), amount: n > 0 && n <= 1e6 ? n : 100 };
}

export const START = [
  "<b>Hedge</b> finds the prediction market that pays you if the thing you're worried about happens, and tells you what it costs and what isn't covered.",
  "Send me a worry, when it could happen, and what you'd lose, like:",
  "• <i>Bitcoin drops below $55k, cover $100, by end of year</i>",
  "• <i>A hurricane hits Houston during my Oct 28–Nov 2 trip, cover $200</i>",
  "• <i>Rain on my outdoor wedding in Lagos on Nov 14, cover $300</i>",
].join("\n");

export function card(r: any, amount: number): { text: string; buttons: any[][] } {
  const lines: string[] = [];
  const notes = (r.worry?.assumptions ?? []).map((a: string) => `ℹ️ <i>${esc(a)}</i>`);
  if (r.verdict === "not_a_hedge") return { text: `🎲 <b>That's a bet, not a hedge.</b>\n\nHedge covers a loss you'd actually suffer. What are you protecting? For example: <i>"I booked a non-refundable $300 trip to the Lakers' next-round game and lose it if they don't advance, cover $300."</i> Send that and I'll find the cover.`, buttons: [] };
  const m = r.match;
  if (!m) {
    // The headline already starts "No good hedge: …"; show the reason once, as a sentence.
    const why = String(r.headline ?? "").replace(/\s*World wasn't searched yet:.*$/, "").replace(/\s*Assumed:.*$/, "").replace(/^No good hedge:\s*/i, "").trim();
    lines.push(`🤷 <b>No good hedge</b>`, esc(why ? why[0]!.toUpperCase() + why.slice(1) : "No listed market pays when this happens."));
    if (notes.length) lines.push("", ...notes);
    lines.push("", "I searched Polymarket. World markets are checked when you use Hedge through an agent with PayBox, so there may still be cover there.");
    return { text: lines.join("\n"), buttons: [[{ text: "Try Hedge in PayBox", url: "https://app.paybox.sh" }]] };
  }
  const label = fitLabel(m.fit);
  lines.push(`${label.icon} <b>${label.title}</b>`);
  lines.push("", `<b>${esc(m.title)}</b>`, `${m.venue === "world" ? "World (Solana)" : "Polymarket"} · buy <b>${esc(m.side)}</b> at ${Math.round(m.price * 1000) / 10}¢`);
  if (m.costToCover != null) {
    const unverified = (m.warnings ?? []).some((w: string) => /^(Size not checked|Depth not checked)/.test(w));
    lines.push(`Cost <b>${usd(m.costToCover)}</b> → pays <b>${usd(m.payout)}</b> if it happens`);
    lines.push(unverified ? `Covers up to ${usd(m.payout)} of your ${usd(amount)} (size unverified)` : `Covers ${usd(m.payout)} of your ${usd(amount)} (${m.coveragePct}%)`);
  }
  lines.push(`Fit: <b>${esc(m.fit)}</b>`);
  const gaps = [...(m.whatsNotCovered ?? []), ...(m.warnings ?? []).filter((w: string) => /depth|size/i.test(w))];
  if (gaps.length) lines.push("", "<b>Not covered</b>", ...gaps.slice(0, 5).map((g: string) => `• ${esc(g)}`));
  if (notes.length) lines.push("", ...notes);
  lines.push("", "<i>Estimates only; prices move. A hedge pays only if the market's rules resolve the way quoted.</i>");
  const buttons = m.venue === "world"
    ? [[{ text: "Buy on World via PayBox", url: "https://app.paybox.sh" }]]
    : m.url ? [[{ text: "Open on Polymarket", url: m.url }]] : [];
  if (m.venue === "world") lines.push("Buying on World happens through your PayBox agent (Hedge + World plugins), with your approval.");
  return { text: lines.join("\n"), buttons };
}

// ---------- follow-up questions ----------
export type Ask = "time" | "loss" | "game";
interface Pending { ask: Ask; worry: string; amount: number; stated: boolean; games?: string[]; at: number }
const pending = new Map<number, Pending>();
const HEAD: Record<Ask, string> = { time: "⏳ <b>By when?</b>", loss: "🧭 <b>What would you actually lose?</b>", game: "🏀 <b>Which game?</b>" };
const MARK = { time: "By when?", loss: "What would you actually lose?", game: "Which game?" } as const;

/** The question text carries the pending worry and amount, so no server state is needed. */
export function question(ask: Ask, worry: string, amount: number, stated: boolean, games: string[] = []): { text: string; buttons: any[][] } {
  const body = ask === "time" ? "This week, this month, by end of year? Tap one, or reply to this message with your own date. I won't guess one."
    : ask === "loss" ? "That sounds like a view about what will happen. Hedge covers a loss you'd suffer. Do you own the asset or property, or have money riding on it? How much? Reply to this message, e.g. <i>I own a $200k flat in Lagos</i>."
    : "More than one market fits. Which one is your bet on? Tap it, or reply with the date or opponent.";
  const list = games.map((g, i) => `${i + 1}. ${esc(g)}`);
  const text = [HEAD[ask], body, ...(list.length ? ["", ...list] : []), "", `Worry: ${esc(worry)}`, `Amount: ${usd(amount)}${stated ? "" : " (default; say \"cover $X\" to change)"}`].join("\n");
  const buttons = ask === "time" ? [[{ text: "This week", callback_data: "t:week" }, { text: "This month", callback_data: "t:month" }], [{ text: "End of year", callback_data: "t:year" }, { text: "No end date", callback_data: "t:any" }]]
    : ask === "loss" ? [[{ text: "Nothing, it's just my view", callback_data: "v:view" }]]
    : games.slice(0, 4).map((g, i) => [{ text: `${i + 1}. ${g.length > 48 ? `${g.slice(0, 47)}…` : g}`, callback_data: `g:${i + 1}` }]);
  return { text, buttons };
}
/** Read a pending question back from the bot's own message text. */
export function readQuestion(text: string | undefined): Pending | null {
  if (!text) return null;
  const ask: Ask | null = text.includes(MARK.time) ? "time" : text.includes(MARK.loss) ? "loss" : text.includes(MARK.game) ? "game" : null;
  const w = /^Worry: (.+)$/m.exec(text); const a = /^Amount: \$([\d,]+(?:\.\d+)?)( \(default)?/m.exec(text);
  if (!ask || !w) return null;
  const games = ask === "game" ? [...text.matchAll(/^(\d)\. (.+)$/gm)].map((m) => m[2]!) : undefined;
  return { ask, worry: w[1]!.trim(), amount: a ? Number(a[1]!.replace(/,/g, "")) : 100, stated: !!a && !a[2], games, at: Date.now() };
}
const fmt = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
/** Turn a timeframe answer into words the parser reads exactly (explicit dates, no AI guessing). */
export function timePhrase(answer: string, now = new Date()): string {
  const a = answer.trim().replace(/[.!]+$/, "");
  if (/^t:week$|^this week$/i.test(a)) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ((7 - now.getUTCDay()) % 7))); return `by ${fmt(d)} (this week)`; }
  if (/^t:month$|^this month$/i.test(a)) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)); return `this month (by ${fmt(d)})`; }
  if (/^t:year$|^(by )?(the )?end of (the )?year$|^this year$/i.test(a)) return `by December 31, ${now.getUTCFullYear()} (end of this year)`;
  if (/^t:any$|^(no end date|any ?time|whenever|no deadline|none|no date|idk|don'?t know|not sure)$/i.test(a)) return "(no end date)";
  if (!timeframeIn(a)) return "(no end date)";
  return /^(by|before|until|till|in|within|during|on|this|next|end|over|for)\b/i.test(a) ? a : `by ${a}`;
}
const NO_LOSS = /^(v:view|no|nope|none|nothing|nah|n\/?a|i don'?t( own| have)?( any| anything)?|not really|just (a|my) (view|opinion|guess)|it'?s just (a|my) (view|opinion)|i'?d rather not( say)?|skip|pass)\b/i;
const VIEW_REPLY = (worry: string) => `🧭 <b>That's a view, not a hedge.</b>\n\nYou expect <i>${esc(worry)}</i>, but you'd lose nothing if it happens, so there's nothing to protect. Buying a market on it would be a bet.\n\nIf you do have exposure (you own property, hold the asset, or have money riding on it), send it with what you'd lose, e.g. <i>I own a $200k flat in Lagos and lose if prices crash by end of 2027, cover $5,000</i>.`;
/** First money amount in a reply: "$200k", "5,000 dollars", "$1.5m". Null if none. */
export function moneyIn(text: string): number | null {
  const m = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b|\b(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\s*(?:usd|dollars)\b/i.exec(text); if (!m) return null;
  const n = Number((m[1] ?? m[3])!.replace(/,/g, "")); const mult = (m[2] ?? m[4] ?? "").toLowerCase();
  return n * (mult === "k" ? 1e3 : mult === "m" ? 1e6 : 1);
}
const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 600);
const dateOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) : "");
/** Distinct fitting markets for an undated sports worry (more than one means: ask which game). */
export function gameChoices(p: Plan): string[] {
  const opts = [p.best, p.buyableNow, ...p.alternatives].filter((o): o is NonNullable<typeof o> => !!o && o.fit !== "none");
  const seen = new Set<string>(); const out: string[] = [];
  for (const o of opts) { const label = `${o.market.title}${o.market.closeTime ? ` (${dateOf(o.market.closeTime)})` : ""}`; if (!seen.has(o.market.title)) { seen.add(o.market.title); out.push(label); } }
  return out.slice(0, 4);
}

type Send = typeof tg;
/** The conversation: bet → view (ask what you'd lose) → timeframe (ask by when) → search → which game (sports) → card. */
export async function respond(chat: number, worry: string, amount: number, stated: boolean, send: Send, now = new Date()): Promise<any> {
  const reply = (t: string, buttons: any[][] = []) => send("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  const ask = (a: Ask, games: string[] = []) => { const q = question(a, worry, amount, stated, games); pending.set(chat, { ask: a, worry, amount, stated, games, at: Date.now() }); if (pending.size > 5000) pending.clear(); return reply(q.text, q.buttons); };
  pending.delete(chat);
  await send("sendChatAction", { chat_id: chat, action: "typing" });
  const w = await understand(worry, now);
  if (w.isBet) return reply(card({ verdict: "not_a_hedge" }, amount).text);
  if (looksLikeView(worry, stated)) return ask("loss");
  const sports = w.category === "sports" || SPORTS.test(worry);
  if (!sports && !timeframeIn(worry)) return ask("time");
  let p = await plan({ worry, amountAtRisk: amount }, now);
  if (p.aiDegraded && p.verdict !== "not_a_hedge") { await send("sendChatAction", { chat_id: chat, action: "typing" }); p = await plan({ worry, amountAtRisk: amount }, now); } // AI timed out: one retry (Telegram allows the time)
  if (p.verdict === "not_a_hedge") return reply(card({ verdict: "not_a_hedge" }, amount).text);
  if (sports && !timeframeIn(worry) && !p.aiDegraded) { const games = gameChoices(p); if (games.length > 1) return ask("game", games); }
  const r = freeView(p, { worry, amountAtRisk: amount });
  if (r.aiDegraded && !r.match) return reply("Hedge's AI is busy right now, so I can't rate the markets properly. Please send it again in a minute.");
  const c = card(r, amount); return reply(c.text, c.buttons);
}
/** Apply an answer to a pending question, then continue the conversation. */
export async function answer(chat: number, q: Pending, ans: string, send: Send, now = new Date()): Promise<any> {
  const reply = (t: string) => send("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", disable_web_page_preview: true });
  pending.delete(chat);
  if (q.ask === "time") return respond(chat, short(`${q.worry.replace(/[.\s]+$/, "")}, ${timePhrase(ans, now)}`), q.amount, q.stated, send, now);
  if (q.ask === "loss") {
    if (NO_LOSS.test(ans.trim())) return reply(VIEW_REPLY(q.worry));
    const amt = amountStated(ans) ? parseAmount(ans).amount : moneyIn(ans);
    const ok = amt != null && amt > 0 && amt <= 1e6;
    return respond(chat, short(`${q.worry.replace(/[.\s]+$/, "")}. ${ans.trim()}`), ok ? amt! : q.amount, q.stated || ok, send, now);
  }
  const pick = /^g:(\d)$/.exec(ans) ?? /^\s*#?(\d)\s*$/.exec(ans);
  const game = pick ? q.games?.[Number(pick[1]) - 1] : null;
  return respond(chat, short(`${q.worry.replace(/[.\s]+$/, "")}, the game: ${game ?? ans.trim()}`), q.amount, q.stated, send, now);
}

/** Handle one Telegram update. Returns what was sent (for tests). */
export async function handleUpdate(u: any, send = tg, now = new Date()): Promise<any> {
  const cq = u?.callback_query;
  if (cq) {
    const chat = cq.message?.chat?.id; await send("answerCallbackQuery", { callback_query_id: cq.id });
    const q = readQuestion(cq.message?.text); if (!chat || !q || typeof cq.data !== "string") return null;
    if (cq.message?.message_id) await send("editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }); // no double taps
    try { return await answer(chat, q, cq.data, send, now); } catch (e) { console.error("[hedge-tg]", (e as Error).message); return send("sendMessage", { chat_id: chat, text: "Hedge hit an error looking that up. Please try again in a moment." }); }
  }
  const msg = u?.message ?? u?.edited_message; const chat = msg?.chat?.id; const text: string = (msg?.text ?? "").trim();
  if (!chat || !text) return null;
  const reply = (t: string, buttons: any[][] = []) => send("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  if (/^\/(start|help)\b/.test(text)) { pending.delete(chat); return reply(START); }
  if (text.startsWith("/")) return reply("Just send me a worry, e.g. <i>Bitcoin drops below $55k by end of year, cover $100</i>.");
  try {
    // An answer to one of my questions: a reply to it, or (same warm instance) a short plain message right after it.
    const rq = msg.reply_to_message?.from?.is_bot ? readQuestion(msg.reply_to_message.text) : null;
    if (rq) return await answer(chat, rq, text, send, now);
    const pq = pending.get(chat);
    if (pq && Date.now() - pq.at < 30 * 6e4 && looksLikeAnswer(pq, text)) return await answer(chat, pq, text, send, now);
    if (!pq && text.length <= 40 && timeframeIn(text) && /^(by |before |until |in |this |next |end |no end|any ?time|whenever)/i.test(text)) return reply("Which worry is that for? Reply to my question (swipe left on it), or send the worry again with the date, e.g. <i>Bitcoin drops below $55k this month</i>.");
    if (text.length < 5 || text.length > 600) return reply("Tell me the worry in a sentence (up to 600 characters), e.g. <i>Bitcoin drops below $55k by end of year, cover $100</i>.");
    const { worry, amount } = parseAmount(text);
    return await respond(chat, worry, amount, amountStated(text), send, now);
  } catch (e) { console.error("[hedge-tg]", (e as Error).message); return reply("Hedge hit an error looking that up. Please try again in a moment."); }
}
/** Is a plain message an answer to the pending question, or a new worry? */
export function looksLikeAnswer(q: Pending, text: string): boolean {
  const t = text.trim();
  if (q.ask === "time") return t.length <= 60 && (timeframeIn(t) || /^(no end date|any ?time|whenever|none|idk|not sure)$/i.test(t));
  if (q.ask === "game") return t.length <= 60 && (/^\s*#?\d\s*$/.test(t) || timeframeIn(t) || /\b(vs\.?|v|against)\b/i.test(t));
  return t.length <= 200 && (NO_LOSS.test(t) || /\b(i|we|my|our)\b.*\b(own|have|hold|bought|invested|lose|rent|lease|mortgage|staked?|bet)\b/i.test(t) || /^\$?\d/.test(t));
}
