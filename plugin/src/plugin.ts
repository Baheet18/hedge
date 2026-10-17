// Hedge PayBox plugin. Thin client for the Hedge service:
//  - hedge_match -> free: best match, side, price and cost to cover (or world_search query when no candidates)
//  - hedge_plan  -> x402 payment proposal (0.01 USDC, Solana if the service accepts it, else Base) for the full plan: best World market, side, cost to cover,
//                     what is and isn't covered, fit rating (or "no good hedge"), and the world_buy_outcome instruction.
// The plugin never buys. Execution is left to PayBox's World plugin (world_buy_outcome), which always asks the user.
// No secrets, no signing. Network host to allow: the Hedge service host (HEDGE_URL).
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";
import { resolveServiceUrl } from "./config.js";

const PROTOCOL_VERSION = "2026-07-28";
const MAX_ATOMIC = process.env.HEDGE_MAX_ATOMIC_USDC || "15000"; // 0.015 USDC ceiling; service charges 0.01
const err = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

const KEEP = /^(id|marketId|market_id|ticker|address|market|title|question|name|subtitle|yesSubTitle|rules|rulesPrimary|rules_primary|rulesSecondary|rules_secondary|description|resolution|resolutionRules|closeTime|close_time|expirationTime|expiration_time|endDate|end_date|resolveTime|closesAt|yesAsk|yes_ask|noAsk|no_ask|yesBid|yes_bid|noBid|no_bid|yesPrice|noPrice|yes_price|no_price|yesBuyPrice|noBuyPrice|prices|yes|no|yesMint|noMint|yes_mint|no_mint|mints|outcomeMints|accounts|url|link|settlementSources|settlement_sources|resolutionSource|yesAskQty|noAskQty|yes_ask_qty|no_ask_qty|askQty|orderbook|eventTicker)$/;
/** Keep only the fields Hedge reads and clip long text, so the paid request body stays well under 64 KiB. */
export function slimCandidate(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "markets" && Array.isArray(v)) { out.markets = v.slice(0, 12).map((x) => (x && typeof x === "object" ? slimCandidate(x as Record<string, unknown>) : x)); continue; }
    if (!KEEP.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 1500);
    else if (v && typeof v === "object") { if (JSON.stringify(v).length <= 4000) out[k] = k === "orderbook" ? JSON.parse(JSON.stringify(v, (_k, x) => (Array.isArray(x) ? x.slice(0, 3) : x))) : v; }
    else out[k] = v;
  }
  return out;
}
const safeSlim = slimCandidate;

const worry = z.string().min(5).max(600).describe("The user's real-life worry in their own words, e.g. \"I'm paid in naira and worried USD/NGN passes 2,000 before December\"");
const planInput = {
  worry,
  amountAtRisk: z.number().positive().max(1_000_000).describe("USD the user stands to lose if the worry happens; Hedge sizes cover to pay this back"),
  maxCost: z.number().positive().max(1_000_000).optional().describe("Optional USD cap on what the hedge may cost; coverage shrinks to fit"),
  candidates: z.array(z.record(z.string(), z.unknown())).max(20).optional().describe("World markets or events as returned by world_get_events(ticker) / world_get_markets(ticker) (search results have no rules, so fetch these first), with asks from world_market_prices and optionally askQty from world_orderbook. Hedge also searches Polymarket itself and ranks everything by fit."),
};

function body(a: { worry: string; amountAtRisk?: number; maxCost?: number; candidates?: Record<string, unknown>[] }) {
  let candidates = (a.candidates ?? []).map(safeSlim);
  while (candidates.length > 1 && Buffer.byteLength(JSON.stringify(candidates)) > 60_000) candidates = candidates.slice(0, -1); // stay under the 64 KiB x402 body limit
  return { worry: a.worry, ...(a.amountAtRisk ? { amountAtRisk: a.amountAtRisk } : {}), ...(a.maxCost ? { maxCost: a.maxCost } : {}), candidates };
}
/** Pay on Solana when the service accepts it (same wallet as the World trade), else Base. */
async function chooseChain(base: string): Promise<"solana:mainnet" | "eip155:8453"> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
  try { const d: any = await (await fetch(`${base}/health`, { signal: ctl.signal })).json(); return (d.networks ?? []).some((n: string) => String(n).startsWith("solana:")) ? "solana:mainnet" : "eip155:8453"; }
  catch { return "eip155:8453"; } finally { clearTimeout(t); }
}

function createServer() {
  const server = new McpServer({ name: "hedge", version: "1.0.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("hedge_match", {
    title: "Hedge: find the cover (free)",
    description: "Free. Start here. Fastest flow (4 calls): 1) world_search once with a short query for the worry (e.g. \"bitcoin\"); 2) world_get_events(ticker) for the top 1-2 event tickers (search hits have no rules or mints); 3) hedge_match with the worry, amountAtRisk and those results as candidates: returns the best market that pays if the worry happens, the side, its price and the cost to cover the amount, free; 4) only if the user wants the full plan, hedge_plan with the same arguments (0.01 USDC). Called with only the worry, it reads the worry, checks Polymarket and returns the world_search query to use. Hedge never buys: World's world_buy_outcome does that after the user agrees. If the user is betting rather than protecting a loss, Hedge says so.",
    inputSchema: z.object({ worry, amountAtRisk: planInput.amountAtRisk.optional(), maxCost: planInput.maxCost, candidates: planInput.candidates }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    let base: string; try { base = resolveServiceUrl(); } catch (e: any) { return err(e.message); }
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9500);
    try {
      const res = await fetch(`${base}/v1/match`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body(a)), signal: ctl.signal });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) return err(`Hedge: ${d.error ?? `HTTP ${res.status}`}`);
      const lines = [String(d.headline ?? ""), ...(Array.isArray(d.next) ? d.next.map(String) : [])].filter(Boolean);
      return { content: [{ type: "text", text: `${lines.join("\n")}\n\n${JSON.stringify({ match: d.match, polymarketReference: d.polymarketReference, worry: d.worry, worldSearch: d.worldSearch })}` }] };
    } catch (e: any) { return err(`Hedge unreachable: ${e?.name === "AbortError" ? "timed out" : e?.message}`); }
    finally { clearTimeout(t); }
  });

  server.registerTool("hedge_plan", {
    title: "Hedge: full hedge plan (0.01 USDC)",
    description: "Turns a real-life worry plus the amount at risk into a hedge plan on World prediction markets. Proposes a paid x402 request (0.01 USDC, on Solana when the service accepts it, otherwise Base). After the user approves, PayBox returns: the World market and side that pays if the worry happens, its price, the cost to cover the amount (price + est. fees), the payout, a quoted rules line for what is covered, plain gaps for what isn't (timing, place, definition), a fit rating (exact/close/loose/none) or an honest \"no good hedge\", and the exact world_buy_outcome call (market, outcome mint, side, USD amount). Hedge is venue-agnostic: it also searches Polymarket, and if the best protection is there it says so with a link (it can only buy on World, through PayBox). It caps cover to the size at the ask and declines bets that aren\'t hedges. Hedge never buys: pass that to world_buy_outcome only after the user agrees. Usually call hedge_match (free) first with the same arguments; pass the same World candidates here. No extra World calls are needed beyond world_search + world_get_events.",
    inputSchema: z.object(planInput).strict(),
    outputSchema: x402OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    let base: string; try { base = resolveServiceUrl(); } catch (e: any) { return err(e.message); }
    try {
      const chain = await chooseChain(base);
      const r = proposeX402({ chain, url: `${base}/v1/plan`, method: "POST", body: body(a) as any, maxAmount: MAX_ATOMIC });
      r.content = [{ type: "text", text: `Proposed a Hedge plan for "${a.worry.slice(0, 80)}" (${a.candidates?.length ?? 0} World candidates; 0.01 USDC on ${chain === "solana:mainnet" ? "Solana" : "Base"}). After you approve, PayBox pays and returns the plan. Nothing has been paid or bought.` }];
      return r;
    } catch (e: any) { return err(`Hedge: ${e.message}`); }
  });
  return server;
}

serveStdio(createServer, { legacy: "reject" });
