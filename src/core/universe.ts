// Market universe. World markets come from the agent (PayBox World plugin output); Polymarket is searched on every request.
import { getJson } from "./http.js";
import type { Candidate } from "./types.js";

const get = (o: any, k: string): any => k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), o);
const pick = (o: any, keys: string[]): any => { for (const k of keys) { const v = get(o, k); if (v !== undefined && v !== null && v !== "") return v; } return null; };
/** Price as a 0..1 probability. Accepts 0.42, "0.42", 42 (cents), "42c", or atomic 420000 (6dp). */
export function price(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  let n = typeof v === "number" ? v : Number(String(v).replace(/[c¢$\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1 && n <= 100) n /= 100; else if (n > 100 && n <= 1_000_000) n /= 1_000_000; else if (n > 1) return null;
  return n;
}
const qty = (v: unknown): number | null => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v); const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** World rules come as { template, tokens }: "BTC trades {threshold} ..." with tokens.threshold.value = "below $45,000". */
export function renderText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(renderText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const o = v as any;
    const tpl = o.template ?? o.text ?? o.format;
    if (typeof tpl === "string") {
      const toks = o.tokens ?? o.values ?? o.params ?? {};
      const val = (k: string) => { const t = Array.isArray(toks) ? toks.find((x: any) => x?.key === k || x?.name === k) : toks[k];
        return t == null ? null : typeof t === "object" ? renderText(t.value ?? t.label ?? t.text ?? t.display ?? "") : String(t); };
      return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}|\$\{\s*([\w.-]+)\s*\}|\{\s*([\w.-]+)\s*\}/g, (m0, a, b, c) => val(a ?? b ?? c) ?? m0);
    }
    if (typeof o.value === "string") return o.value;
  }
  return "";
}
function sourcesOf(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map((s: any) => typeof s === "string" ? s : [s?.name ?? s?.label ?? s?.source, s?.url].filter(Boolean).join(" ")).filter(Boolean).slice(0, 4);
}
/** Best-ask quantity for a side from askQty fields or a world_orderbook-style object. */
function askQtyOf(m: any, side: "yes" | "no"): number | null {
  const direct = qty(pick(m, [`${side}AskQty`, `${side}_ask_qty`, `${side}AskSize`, `askQty.${side}`, `orderbook.${side}.askQty`, `orderbook.${side}AskQty`]));
  if (direct !== null) return direct;
  const asks = pick(m, [`orderbook.${side}.asks`, `orderbook.${side}Asks`, `orderbook.${side}_asks`]);
  if (Array.isArray(asks) && asks.length) { const a = asks[0]; return qty(Array.isArray(a) ? a[1] : a?.qty ?? a?.quantity ?? a?.size ?? a?.amount); }
  if (side === "yes") return qty(pick(m, ["askQty", "ask_qty"]));
  return null;
}

/** Normalise World markets as returned by world_search / world_get_events / world_get_markets (events with markets[] are flattened). */
export function normalizeWorldAll(input: any): Candidate[] {
  if (input && typeof input === "object" && Array.isArray(input.markets)) {
    const ev = { settlementSources: input.settlementSources ?? input.settlement_sources, eventTitle: input.title, rulesPrimary: input.rulesPrimary, rulesSecondary: input.rulesSecondary };
    return input.markets.map((m: any) => normalizeWorld({ ...m, settlementSources: m.settlementSources ?? ev.settlementSources, rulesPrimary: m.rulesPrimary ?? ev.rulesPrimary, rulesSecondary: m.rulesSecondary ?? ev.rulesSecondary,
      title: m.title && ev.eventTitle && !String(renderText(m.title)).includes(String(ev.eventTitle)) ? `${renderText(ev.eventTitle)}: ${renderText(m.title)}` : m.title ?? ev.eventTitle })).filter((c: Candidate | null): c is Candidate => !!c);
  }
  const c = normalizeWorld(input); return c ? [c] : [];
}
export function normalizeWorld(input: any): Candidate | null {
  if (!input || typeof input !== "object") return null;
  let m = input;
  const id = pick(m, ["ticker", "marketId", "market_id", "id", "address", "market"]);
  const title = renderText(pick(m, ["title", "question", "name", "yesSubTitle", "subtitle"]));
  if (!id || !title) return null;
  // World catalog shape: accounts = { <collateralMint>: { marketLedger, yesMint, noMint, isInitialized } }
  if (m.accounts && typeof m.accounts === "object" && !m.accounts.yesMint) {
    const acc: any = Object.values(m.accounts).find((a: any) => a && a.yesMint && a.isInitialized !== false) ?? Object.values(m.accounts).find((a: any) => a?.yesMint);
    if (acc) m = { ...m, yesMint: m.yesMint ?? acc.yesMint, noMint: m.noMint ?? acc.noMint };
  }
  const rules = [pick(m, ["rules", "rulesPrimary", "rules_primary", "description", "resolution", "resolutionRules"]), pick(m, ["rulesSecondary", "rules_secondary"])].map(renderText).filter(Boolean).join("\n");
  const yesAsk = price(pick(m, ["yesAsk", "yes_ask", "yesBuyPrice", "prices.yes.ask", "prices.yesAsk", "yes.ask", "yesPrice", "yes_price", "prices.yes"]));
  const noAsk = price(pick(m, ["noAsk", "no_ask", "noBuyPrice", "prices.no.ask", "prices.noAsk", "no.ask", "noPrice", "no_price", "prices.no"]));
  return {
    source: "world", venue: "world", marketId: String(id), title: title.slice(0, 300), rules: rules.slice(0, 4000),
    closeTime: iso(pick(m, ["closeTime", "close_time", "expirationTime", "expiration_time", "endDate", "end_date", "resolveTime", "closesAt"])),
    yesAsk, noAsk,
    yesBid: price(pick(m, ["yesBid", "yes_bid", "prices.yes.bid", "yes.bid"])), noBid: price(pick(m, ["noBid", "no_bid", "prices.no.bid", "no.bid"])),
    yesMint: pick(m, ["yesMint", "yes_mint", "accounts.yesMint", "mints.yes", "yes.mint", "outcomeMints.yes"]),
    noMint: pick(m, ["noMint", "no_mint", "accounts.noMint", "mints.no", "no.mint", "outcomeMints.no"]),
    url: pick(m, ["url", "link"]), sources: sourcesOf(pick(m, ["settlementSources", "settlement_sources", "resolutionSource", "sources"])),
    askQty: { yes: askQtyOf(m, "yes"), no: askQtyOf(m, "no") },
  };
}

export async function polymarketSearch(q: string, ms = 2500): Promise<Candidate[]> {
  const d = await getJson(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}&limit_per_type=6&events_status=active`, { ms });
  const out: Candidate[] = [];
  for (const e of d.events ?? []) for (const m of (e.markets ?? []).slice(0, 80)) {
    if (m.closed || m.active === false) continue;
    const end = iso(m.endDate ?? e.endDate); if (end && new Date(end).getTime() - Date.now() < 48 * 36e5) continue; // resolves within 48h: never real cover
    let tok: string[] = []; try { tok = JSON.parse(m.clobTokenIds ?? "[]"); } catch { /* ignore */ }
    let yes: number | null = null, no: number | null = null;
    try { const p = JSON.parse(m.outcomePrices ?? "[]"); yes = price(p[0]); no = price(p[1]); } catch { /* ignore */ }
    const yesAsk = price(m.bestAsk) ?? yes; const yesBid = price(m.bestBid);
    out.push({ source: "reference", venue: "polymarket", marketId: String(m.slug ?? m.id), title: String(m.question ?? e.title), rules: String(m.description ?? e.description ?? "").slice(0, 4000),
      closeTime: end, yesAsk, noAsk: yesBid !== null ? Math.min(1, 1 - yesBid) : no, yesBid, noBid: yesAsk !== null ? 1 - yesAsk : null,
      yesMint: null, noMint: null, url: `https://polymarket.com/event/${e.slug}`, sources: m.resolutionSource ? [String(m.resolutionSource)] : [], askQty: { yes: null, no: null }, tokenIds: { yes: tok[0] ?? null, no: tok[1] ?? null } });
  }
  return out;
}

/** Search every query, merge and de-duplicate, then rank by `score` (overlap with the worry), drop zero-overlap hits, then cap. */
export async function referenceCandidates(queries: string[], score: (c: Candidate) => number, cap = 24, ms = 2500): Promise<{ candidates: Candidate[]; warnings: string[] }> {
  const warnings: string[] = [];
  const rs = await Promise.allSettled(queries.slice(0, 4).map((q) => polymarketSearch(q, ms)));
  rs.forEach((r, i) => console.log("[hedge] polymarket q=", JSON.stringify(queries[i]), r.status === "fulfilled" ? `${r.value.length} markets` : `failed: ${r.reason?.message ?? r.reason}`));
  const seen = new Map<string, Candidate>();
  rs.forEach((r, i) => { if (r.status === "rejected") warnings.push(`Polymarket search "${queries[i]}" failed: ${r.reason?.message ?? r.reason}`);
    else for (const c of r.value) if (!seen.has(c.marketId)) seen.set(c.marketId, c); });
  const ranked = [...seen.values()].map((c) => ({ c, o: score(c) })).filter((x) => x.o > 0).sort((a, b) => b.o - a.o);
  return { candidates: ranked.slice(0, cap).map((x) => x.c), warnings };
}

/** Shares available at the best ask on Polymarket's CLOB (public). null when not checked. */
export async function polymarketDepth(tokenId: string, ask: number, ms = 1200): Promise<number | null> {
  try { const d = await getJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, { ms });
    const asks = (d.asks ?? []).map((a: any) => ({ p: Number(a.price), s: Number(a.size) })).filter((a: any) => a.p > 0 && a.s > 0);
    if (!asks.length) return 0; return asks.filter((a: any) => a.p <= ask + 0.005).reduce((t: number, a: any) => t + a.s, 0);
  } catch { return null; }
}
