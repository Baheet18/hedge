// Market universe. Primary: World markets the agent fetched with world_search / world_get_markets and passed in.
// Reference only (cannot be bought through PayBox's World plugin): Polymarket public search.
import { getJson } from "./http.js";
import type { Candidate } from "./types.js";

const pick = (o: any, keys: string[]): any => { for (const k of keys) { const v = k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), o); if (v !== undefined && v !== null && v !== "") return v; } return null; };
/** Price as a 0..1 probability. Accepts 0.42, "0.42", 42 (cents), "42c", or atomic 420000 (6dp). */
export function price(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  let n = typeof v === "number" ? v : Number(String(v).replace(/[c¢$\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1 && n <= 100) n /= 100; else if (n > 100 && n <= 1_000_000) n /= 1_000_000; else if (n > 1) return null;
  return n;
}
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v); const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Normalise one market object as returned by World's plugin tools (field names vary, so be liberal). */
export function normalizeWorld(input: any): Candidate | null {
  if (!input || typeof input !== "object") return null;
  let m = input;
  const id = pick(m, ["marketId", "market_id", "id", "ticker", "address", "market"]);
  const title = pick(m, ["title", "question", "name", "yesSubTitle", "subtitle"]);
  if (!id || !title) return null;
  // World catalog shape: accounts = { <collateralMint>: { marketLedger, yesMint, noMint, isInitialized } }
  if (m.accounts && typeof m.accounts === "object" && !m.accounts.yesMint) {
    const acc: any = Object.values(m.accounts).find((a: any) => a && a.yesMint && a.isInitialized !== false) ?? Object.values(m.accounts).find((a: any) => a?.yesMint);
    if (acc) m = { ...m, yesMint: m.yesMint ?? acc.yesMint, noMint: m.noMint ?? acc.noMint };
  }
  const rules = [pick(m, ["rules", "rulesPrimary", "rules_primary", "description", "resolution", "resolutionRules"]), pick(m, ["rulesSecondary", "rules_secondary"])].filter(Boolean).join("\n");
  const yesAsk = price(pick(m, ["yesAsk", "yes_ask", "yesBuyPrice", "prices.yes.ask", "prices.yesAsk", "yes.ask", "yesPrice", "yes_price", "prices.yes"]));
  const noAsk = price(pick(m, ["noAsk", "no_ask", "noBuyPrice", "prices.no.ask", "prices.noAsk", "no.ask", "noPrice", "no_price", "prices.no"]));
  return {
    source: "world", venue: "world", marketId: String(id), title: String(title).slice(0, 300), rules: String(rules).slice(0, 4000),
    closeTime: iso(pick(m, ["closeTime", "close_time", "expirationTime", "expiration_time", "endDate", "end_date", "resolveTime", "closesAt"])),
    yesAsk, noAsk,
    yesBid: price(pick(m, ["yesBid", "yes_bid", "prices.yes.bid", "yes.bid"])), noBid: price(pick(m, ["noBid", "no_bid", "prices.no.bid", "no.bid"])),
    yesMint: pick(m, ["yesMint", "yes_mint", "accounts.yesMint", "mints.yes", "yes.mint", "outcomeMints.yes"]),
    noMint: pick(m, ["noMint", "no_mint", "accounts.noMint", "mints.no", "no.mint", "outcomeMints.no"]),
    url: pick(m, ["url", "link"]),
  };
}

export async function polymarketSearch(q: string, ms = 2500): Promise<Candidate[]> {
  const d = await getJson(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}&limit_per_type=4&events_status=active`, { ms });
  const out: Candidate[] = [];
  for (const e of d.events ?? []) for (const m of (e.markets ?? []).slice(0, 6)) {
    if (m.closed || m.active === false) continue;
    let yes: number | null = null, no: number | null = null;
    try { const p = JSON.parse(m.outcomePrices ?? "[]"); yes = price(p[0]); no = price(p[1]); } catch { /* ignore */ }
    const yesAsk = price(m.bestAsk) ?? yes; const yesBid = price(m.bestBid);
    out.push({ source: "reference", venue: "polymarket", marketId: String(m.slug ?? m.id), title: String(m.question ?? e.title), rules: String(m.description ?? e.description ?? "").slice(0, 4000),
      closeTime: iso(m.endDate ?? e.endDate), yesAsk, noAsk: yesBid !== null ? Math.min(1, 1 - yesBid) : no, yesBid, noBid: yesAsk !== null ? 1 - yesAsk : null,
      yesMint: null, noMint: null, url: `https://polymarket.com/event/${e.slug}` });
  }
  return out;
}

export async function referenceCandidates(queries: string[]): Promise<{ candidates: Candidate[]; warnings: string[] }> {
  const warnings: string[] = [];
  const rs = await Promise.allSettled(queries.slice(0, 3).map((q) => polymarketSearch(q)));
  const seen = new Set<string>(); const candidates: Candidate[] = [];
  rs.forEach((r, i) => { if (r.status === "rejected") warnings.push(`reference search "${queries[i]}" failed: ${r.reason?.message ?? r.reason}`);
    else for (const c of r.value) if (!seen.has(c.marketId)) { seen.add(c.marketId); candidates.push(c); } });
  return { candidates: candidates.slice(0, 24), warnings };
}
