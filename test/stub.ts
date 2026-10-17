// Offline stubs for Gemini and Polymarket.
export type Gem = { parse?: object; judge?: (prompt: string) => object };
export function stubFetch(o: { gemini?: Gem; poly?: any[] }) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("gamma-api.polymarket.com")) return new Response(JSON.stringify({ events: o.poly ?? [] }), { status: 200 });
    if (u.includes("generativelanguage")) {
      if (!o.gemini) return new Response("{}", { status: 429 });
      const body = JSON.parse(init.body); const isJudge = JSON.stringify(body.generationConfig.responseSchema).includes("ratings");
      const out = isJudge ? o.gemini.judge?.(body.contents[0].parts[0].text) : o.gemini.parse;
      if (!out) return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as any;
  return () => { globalThis.fetch = real; };
}
export const polyEvent = (slug: string, markets: Array<{ q: string; desc?: string; ask: number; bid?: number; end?: string }>) => ({ slug, title: slug, endDate: "2026-12-01T00:00:00Z",
  markets: markets.map((m, i) => ({ id: `${slug}-${i}`, slug: `${slug}-${i}`, question: m.q, description: m.desc ?? m.q, bestAsk: m.ask, bestBid: m.bid ?? m.ask - 0.01, outcomePrices: JSON.stringify([String(m.ask), String(1 - m.ask)]), endDate: m.end ?? "2026-12-01T00:00:00Z", active: true, closed: false })) });
