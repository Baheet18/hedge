// Standalone Hedge Telegram bot (webhook). Free match only, no x402. World data isn't public server-side,
// so standalone matches come from Polymarket; World buys go through an agent with PayBox.
import { createHash } from "node:crypto";
import { freeMatch } from "./core/plan.js";

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
export function parseAmount(text: string): { worry: string; amount: number } {
  const re = /[,;.]?\s*\b(?:cover|insure|protect|hedge|risking|at risk of|i(?:'d| would)? lose|lose)\s+(?:me\s+)?(?:up to\s+)?\$?\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:usd|dollars)?\b/i;
  const m = re.exec(text) ?? /[,;]\s*\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:at risk)?\s*$/i.exec(text);
  if (!m) return { worry: text.trim(), amount: 100 };
  const n = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return { worry: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim().replace(/[,;\s]+$/, ""), amount: n > 0 && n <= 1e6 ? n : 100 };
}

export const START = [
  "<b>Hedge</b> finds the prediction market that pays you if the thing you're worried about happens, and tells you what it costs and what isn't covered.",
  "Send me a worry and an amount, like:",
  "• <i>Bitcoin drops below $55k, cover $100</i>",
  "• <i>A hurricane hits Houston during my Oct 28–Nov 2 trip, cover $200</i>",
  "• <i>Rain on my outdoor wedding in Lagos on Nov 14, cover $300</i>",
].join("\n");

export function card(r: any, amount: number): { text: string; buttons: any[][] } {
  const lines: string[] = [];
  if (r.verdict === "not_a_hedge") return { text: `🎲 <b>That's a bet, not a hedge.</b>\n\nHedge covers a loss you'd actually suffer. What are you protecting? For example: <i>"I booked a non-refundable $300 trip to the Lakers' next-round game and lose it if they don't advance, cover $300."</i> Send that and I'll find the cover.`, buttons: [] };
  const m = r.match;
  if (!m) {
    lines.push(`🤷 <b>No good hedge</b>`, esc(r.headline.replace(/\s*World wasn't searched yet:.*$/, "")));
    lines.push("", "I searched Polymarket. World markets are checked when you use Hedge through an agent with PayBox, so there may still be cover there.");
    return { text: lines.join("\n"), buttons: [[{ text: "Try Hedge in PayBox", url: "https://app.paybox.sh" }]] };
  }
  const icon = m.fit === "exact" ? "🛡️" : m.fit === "close" ? "✅" : "⚠️";
  lines.push(`${icon} <b>${m.fit === "loose" ? "Partial hedge (loose fit)" : m.fit === "exact" ? "Good hedge" : "Decent hedge"}</b>`);
  lines.push("", `<b>${esc(m.title)}</b>`, `${m.venue === "world" ? "World (Solana)" : "Polymarket"} · buy <b>${esc(m.side)}</b> at ${Math.round(m.price * 1000) / 10}¢`);
  if (m.costToCover != null) {
    const unverified = (m.warnings ?? []).some((w: string) => /^(Size not checked|Depth not checked)/.test(w));
    lines.push(`Cost <b>${usd(m.costToCover)}</b> → pays <b>${usd(m.payout)}</b> if it happens`);
    lines.push(unverified ? `Covers up to ${usd(m.payout)} of your ${usd(amount)} (size unverified)` : `Covers ${usd(m.payout)} of your ${usd(amount)} (${m.coveragePct}%)`);
  }
  lines.push(`Fit: <b>${esc(m.fit)}</b>`);
  const gaps = [...(m.whatsNotCovered ?? []), ...(m.warnings ?? []).filter((w: string) => /depth|size/i.test(w))];
  if (gaps.length) lines.push("", "<b>Not covered</b>", ...gaps.slice(0, 5).map((g: string) => `• ${esc(g)}`));
  lines.push("", "<i>Estimates only; prices move. A hedge pays only if the market's rules resolve the way quoted.</i>");
  const buttons = m.venue === "world"
    ? [[{ text: "Buy on World via PayBox", url: "https://app.paybox.sh" }]]
    : m.url ? [[{ text: "Open on Polymarket", url: m.url }]] : [];
  if (m.venue === "world") lines.push("Buying on World happens through your PayBox agent (Hedge + World plugins), with your approval.");
  return { text: lines.join("\n"), buttons };
}

/** Handle one Telegram update. Returns what was sent (for tests). */
export async function handleUpdate(u: any, send = tg): Promise<any> {
  const msg = u?.message ?? u?.edited_message; const chat = msg?.chat?.id; const text: string = (msg?.text ?? "").trim();
  if (!chat || !text) return null;
  const reply = (t: string, buttons: any[][] = []) => send("sendMessage", { chat_id: chat, text: t, parse_mode: "HTML", disable_web_page_preview: true, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  if (/^\/(start|help)\b/.test(text)) return reply(START);
  if (text.startsWith("/")) return reply("Just send me a worry, e.g. <i>Bitcoin drops below $55k, cover $100</i>.");
  if (text.length < 5 || text.length > 600) return reply("Tell me the worry in a sentence (up to 600 characters), e.g. <i>Bitcoin drops below $55k, cover $100</i>.");
  await send("sendChatAction", { chat_id: chat, action: "typing" });
  const { worry, amount } = parseAmount(text);
  try {
    let r: any = await freeMatch({ worry, amountAtRisk: amount });
    if (r.aiDegraded && r.verdict !== "not_a_hedge") { await send("sendChatAction", { chat_id: chat, action: "typing" }); r = await freeMatch({ worry, amountAtRisk: amount }); } // AI timed out: one retry (Telegram allows the time)
    if (r.aiDegraded && !r.match && r.verdict !== "not_a_hedge") return reply("Hedge's AI is busy right now, so I can't rate the markets properly. Please send it again in a minute.");
    const c = card(r, amount); return reply(c.text, c.buttons);
  } catch (e) { console.error("[hedge-tg]", (e as Error).message); return reply("Hedge hit an error looking that up. Please try again in a moment."); }
}
