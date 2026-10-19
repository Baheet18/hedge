// Regression (Oct 19 live test): "I'm worried Bitcoin crashes this week/month/year" said "no listed market pays".
// Cause: no price level → every Bitcoin line scored the same, the first six were upside "reach $X" lines, all rated none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdate, question } from "../src/telegram.js";
import { groundThreshold, rulesParse, regexParse } from "../src/core/worry.js";
import { freeMatch, snapLevel, crashPct, directionBoost } from "../src/core/plan.js";
import { stubFetch, polyEvent } from "./stub.js";

const NOW = new Date("2026-10-19T08:00:00Z");
const SPOT = 82643;
const k = (n: number) => `$${n.toLocaleString("en-US")}`;
// Live-shaped ladders, upside lines first (as Polymarket returns them).
const weekly = polyEvent("btc-week", [...[96, 94, 92, 90, 88, 86, 84].map((n) => ({ q: `Will Bitcoin reach ${k(n * 1000)} October 19-25?`, ask: 0.05, end: "2026-10-26T04:00:00Z" })),
  ...[80, 78, 76, 74, 72, 70, 68].map((n, i) => ({ q: `Will Bitcoin dip to ${k(n * 1000)} October 19-25?`, desc: "Bitcoin price dip, Binance BTC/USDT 1 minute candle low", ask: [0.44, 0.18, 0.09, 0.055, 0.022, 0.014, 0.014][i]!, end: "2026-10-26T04:00:00Z" }))]);
const monthly = polyEvent("btc-oct", [...[150, 105, 100, 97.5, 95, 92.5, 90, 87.5].map((n) => ({ q: `Will Bitcoin reach ${k(n * 1000)} in October?`, ask: 0.02, end: "2026-11-01T04:00:00Z" })),
  ...[77.5, 75, 72.5, 70, 67.5, 65, 62.5, 60].map((n, i) => ({ q: `Will Bitcoin dip to ${k(n * 1000)} in October?`, desc: "Bitcoin price dip, Binance BTC/USDT 1 minute candle low", ask: [0.32, 0.17, 0.1, 0.06, 0.026, 0.015, 0.009, 0.009][i]!, end: "2026-11-01T04:00:00Z" }))]);
const yearly = polyEvent("btc-2026", [...[200, 150, 120, 100].map((n) => ({ q: `Will Bitcoin reach ${k(n * 1000)} by December 31, 2026?`, ask: 0.05, end: "2027-01-01T05:00:00Z" })),
  ...[70, 65, 60, 55].map((n, i) => ({ q: `Will Bitcoin dip to ${k(n * 1000)} by December 31, 2026?`, desc: "Bitcoin price dip, Binance BTC/USDT 1 minute candle low", ask: [0.36, 0.23, 0.16, 0.11][i]!, end: "2027-01-01T05:00:00Z" }))]);
const parse = (deadline: string) => ({ summary: "Bitcoin crashes", category: "crypto", subject: "bitcoin price", direction: "happens", threshold: null, unit: null, location: null, deadline, windowStart: null, searchQueries: ["bitcoin price", "btc usd", "bitcoin"], keyTerms: ["bitcoin", "btc", "crash"], isBet: false });
/** A judge like Gemini's: upside lines don't pay on a crash; a dip line at the parsed level is close; another level or a window that ends early is loose. */
const judge = (p: string) => {
  const parsed = JSON.parse(/Parsed: (\{.*\})/.exec(p)?.[1] ?? "{}"); const lines = p.split("\n");
  return { ratings: lines.map((l, i) => [l, lines[i + 1] ?? ""] as const).filter(([l]) => /^#\d+ /.test(l)).map(([l, next]) => {
    const close = /closes: (\S+)/.exec(next)?.[1]; const early = parsed.deadline && close && new Date(close).getTime() < new Date(`${parsed.deadline}T00:00:00Z`).getTime() - 2 * 864e5;
    const lvl = /dip to \$([\d,]+)/.exec(l)?.[1]?.replace(/,/g, "");
    const fit = !lvl ? "none" : early || Number(lvl) !== parsed.threshold ? "loose" : "close";
    return { index: Number(l.slice(1, l.indexOf(" "))), fit, side: "YES", covered: "Pays if Bitcoin dips to that level in the window.", quote: null, gaps: [] }; }) };
};
const withKey = async (fn: () => Promise<void>) => { process.env.GEMINI_API_KEY = "k"; try { await fn(); } finally { delete process.env.GEMINI_API_KEY; } };
const CASES = [
  { phrase: "this week", deadline: "2026-10-25", market: /dip to \$74,000 October 19-25/, tap: "t:week" },
  { phrase: "this month", deadline: "2026-10-31", market: /dip to \$70,000 in October/, tap: "t:month" },
  { phrase: "this year", deadline: "2026-12-31", market: /dip to \$65,000 by December 31, 2026/, tap: "t:year" },
];

for (const c of CASES) test(`regression: 'I'm worried Bitcoin crashes ${c.phrase}' finds a Bitcoin dip market (free match, typed, button)`, () => withKey(async () => {
  const restore = stubFetch({ poly: [weekly, monthly, yearly], spot: SPOT, gemini: { parse: parse(c.deadline), judge } });
  try {
    const f = await freeMatch({ worry: `I'm worried Bitcoin crashes ${c.phrase}`, amountAtRisk: 100 }, NOW);
    assert.notEqual(f.verdict, "no_good_hedge", f.headline); assert.match(f.match!.title, c.market, f.match!.title); assert.equal(f.match!.fit, "close", JSON.stringify([f.match!.title, f.match!.whatsNotCovered, f.worry]));
    assert.ok(f.worry.assumptions.some((a: string) => /didn't give a price, so I took a crash as Bitcoin falling about \d+% from today's \$82,643/.test(a)), f.worry.assumptions.join("|"));
    // Typed as one message (Baheet's test), with an amount
    const sent: any[] = []; const send = (async (m: string, b: any) => { sent.push([m, b]); return {}; }) as any;
    await handleUpdate({ message: { chat: { id: 5 }, text: `I'm worried Bitcoin crashes ${c.phrase} I want to cover $5,000` } }, send, NOW);
    const typed = sent.filter((s) => s[0] === "sendMessage").at(-1)![1].text as string;
    assert.doesNotMatch(typed, /No good hedge/); assert.match(typed, c.market); assert.match(typed, /of your \$5000\.00/); assert.match(typed, /didn't give a price/);
    // Button tap after "By when?"
    const q = question("time", "I'm worried Bitcoin crashes", 100, false); sent.length = 0;
    await handleUpdate({ callback_query: { id: "x", data: c.tap, message: { message_id: 1, chat: { id: 5 }, text: q.text.replace(/<[^>]+>/g, "") } } }, send, NOW);
    const tapped = sent.filter((s) => s[0] === "sendMessage").at(-1)![1].text as string;
    assert.doesNotMatch(tapped, /No good hedge/); assert.match(tapped, c.market);
  } finally { restore(); }
}));

test("crash helpers: window-sized drop, snap to a listed dip strike, rank dips over upside lines", () => {
  assert.equal(crashPct("2026-10-25", NOW), 0.1); assert.equal(crashPct("2026-10-31", NOW), 0.15); assert.equal(crashPct("2026-12-31", NOW), 0.2); assert.equal(crashPct(null, NOW), 0.2);
  const cs = [...monthly.markets, ...yearly.markets].map((m: any) => ({ title: m.question })) as any;
  assert.equal(snapLevel(66000, cs), 65000); assert.equal(snapLevel(30000, cs), 30000, "nothing near: keep the level");
  const w = { direction: "below" } as any;
  assert.ok(directionBoost(w, { title: "Will Bitcoin dip to $70,000 in October?" } as any) > 0); assert.ok(directionBoost(w, { title: "Will Bitcoin reach $150,000 in October?" } as any) < 0);
  assert.equal(directionBoost({ direction: "happens" } as any, { title: "Will Bitcoin reach $150,000?" } as any), 0);
});

test("regression: the AI inventing a level ($50,000, or the $100 cover amount) is dropped, so the crash level is assumed and stated", () => withKey(async () => {
  const w = (text: string, threshold: number) => ({ ...rulesParse(text, NOW), text, threshold, direction: "below" as const });
  assert.equal(groundThreshold(w("I'm worried Bitcoin crashes this week", 50000)).threshold, null);
  assert.equal(groundThreshold(w("I'm worried Bitcoin crashes this month, cover $100", 100)).threshold, null);
  assert.equal(groundThreshold(w("Bitcoin drops below $55k this month, cover $100", 55000)).threshold, 55000);
  assert.equal(groundThreshold(w("naira passes 2,000 per dollar", 2000)).threshold, 2000);
  assert.equal(groundThreshold({ ...w("the Fed hikes twice", 2), direction: "happens" }).threshold, 2, "only price levels are grounded");
  assert.equal(regexParse("I'm worried Bitcoin crashes this month, cover $100", NOW), null, "the cover amount isn't a price level ('cover' isn't 'over')");
  assert.equal(regexParse("Bitcoin drops below $55k, cover $100", NOW)!.threshold, 55000);
  for (const invented of [50000, 100]) {
    const restore = stubFetch({ poly: [weekly, monthly, yearly], spot: SPOT, gemini: { parse: { ...parse("2026-10-31"), threshold: invented, direction: "below" }, judge } });
    try { const f = await freeMatch({ worry: "I'm worried Bitcoin crashes this month, cover $100", amountAtRisk: 100 }, NOW);
      assert.match(f.match!.title, /dip to \$70,000 in October/, `${invented}: ${f.headline}`); assert.match(f.worry.assumptions.join(" "), /didn't give a price/);
    } finally { restore(); }
  }
}));

test("regression: for a this-month worry, a weekly market that ends 5 days early is marked down, so the October market wins", () => withKey(async () => {
  // A judge that (like the live one) calls both close; the code check must mark the early-closing weekly line down.
  const lenient = (p: string) => ({ ratings: p.split("\n").filter((l) => /^#\d+ /.test(l)).map((l) => ({ index: Number(l.slice(1, l.indexOf(" "))), fit: /dip to \$70,000/.test(l) ? "close" : "none", side: "YES", covered: "Pays on a dip.", quote: null, gaps: [] })) });
  const restore = stubFetch({ poly: [weekly, monthly, yearly], spot: SPOT, gemini: { parse: parse("2026-10-31"), judge: lenient } });
  try { const f = await freeMatch({ worry: "I'm worried Bitcoin crashes this month", amountAtRisk: 100 }, NOW);
    assert.match(f.match!.title, /dip to \$70,000 in October/, f.match!.title); assert.equal(f.match!.fit, "close");
  } finally { restore(); }
}));
