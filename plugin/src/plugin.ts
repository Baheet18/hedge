// Hedge PayBox plugin. Thin client for the Hedge service:
//  - hedge_preview -> free: reads the worry and returns world_search queries to find candidate World markets
//  - hedge_plan    -> x402 payment proposal (0.10 USDC on Base) for the full plan: best World market, side, cost to cover,
//                     what is and isn't covered, fit rating (or "no good hedge"), and the world_buy_outcome instruction.
// The plugin never buys. Execution is left to PayBox's World plugin (world_buy_outcome), which always asks the user.
// No secrets, no signing. Network host to allow: the Hedge service host (HEDGE_URL).
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";
import { resolveServiceUrl } from "./config.js";

const PROTOCOL_VERSION = "2026-07-28";
const MAX_ATOMIC = process.env.HEDGE_MAX_ATOMIC_USDC || "150000"; // 0.15 USDC ceiling; service charges 0.10
const err = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

const KEEP = /^(id|marketId|market_id|ticker|address|market|title|question|name|subtitle|yesSubTitle|rules|rulesPrimary|rules_primary|rulesSecondary|rules_secondary|description|resolution|resolutionRules|closeTime|close_time|expirationTime|expiration_time|endDate|end_date|resolveTime|closesAt|yesAsk|yes_ask|noAsk|no_ask|yesBid|yes_bid|noBid|no_bid|yesPrice|noPrice|yes_price|no_price|yesBuyPrice|noBuyPrice|prices|yes|no|yesMint|noMint|yes_mint|no_mint|mints|outcomeMints|accounts|url|link)$/;
/** Keep only the fields Hedge reads and clip long text, so the paid request body stays well under 64 KiB. */
export function slimCandidate(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (!KEEP.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 1500);
    else if (v && typeof v === "object") { if (JSON.stringify(v).length <= 3000) out[k] = v; }
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
  candidates: z.array(z.record(z.string(), z.unknown())).max(12).optional().describe("World markets from world_search / world_get_markets / world_market_prices, passed as returned (id, title, rules, close time, yes/no asks, yes/no mints). Without them Hedge only compares against non-buyable reference markets."),
};

function createServer() {
  const server = new McpServer({ name: "hedge", version: "1.0.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("hedge_preview", {
    title: "Hedge: read the worry (free)",
    description: "Free first step. Give the user's worry; Hedge returns what event it means (threshold, place, deadline) and the world_search queries to run. Then call world_search, gather the matching World markets (world_get_markets / world_market_prices for rules, asks and mints), and pass them to hedge_plan as candidates.",
    inputSchema: z.object({ worry }).strict(),
    outputSchema: z.object({ summary: z.string(), category: z.string(), threshold: z.number().nullable(), deadline: z.string().nullable(), location: z.string().nullable(), worldSearch: z.array(z.string()), next: z.array(z.string()) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    let base: string; try { base = resolveServiceUrl(); } catch (e: any) { return err(e.message); }
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
    try {
      const res = await fetch(`${base}/v1/preview`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ worry: a.worry }), signal: ctl.signal });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) return err(`Hedge: ${d.error ?? `HTTP ${res.status}`}`);
      const w = d.worry ?? {};
      const out = { summary: String(w.summary ?? a.worry), category: String(w.category ?? "other"), threshold: typeof w.threshold === "number" ? w.threshold : null, deadline: w.deadline ?? null, location: w.location ?? null,
        worldSearch: Array.isArray(d.worldSearch) ? d.worldSearch.map(String) : [], next: Array.isArray(d.next) ? d.next.map(String) : [] };
      return { content: [{ type: "text", text: `Worry read as: ${out.summary}. Next: world_search ${out.worldSearch.map((q: string) => JSON.stringify(q)).join(", ")}, then hedge_plan with the World markets you find.` }], structuredContent: out };
    } catch (e: any) { return err(`Hedge unreachable: ${e?.name === "AbortError" ? "timed out" : e?.message}`); }
    finally { clearTimeout(t); }
  });

  server.registerTool("hedge_plan", {
    title: "Hedge: paid hedge plan",
    description: "Turns a real-life worry plus the amount at risk into a hedge plan on World prediction markets. Proposes a paid x402 request (0.10 USDC on Base). After the user approves, PayBox returns: the World market and side that pays if the worry happens, its price, the cost to cover the amount (price + est. fees), the payout, a quoted rules line for what is covered, plain gaps for what isn't (timing, place, definition), a fit rating (exact/close/loose/none) or an honest \"no good hedge\", and the exact world_buy_outcome call (market, outcome mint, side, USD amount). Hedge never buys: pass that to world_buy_outcome only after the user agrees. Call hedge_preview first to get world_search queries, and pass the World markets you found as candidates.",
    inputSchema: z.object(planInput).strict(),
    outputSchema: x402OutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    let base: string; try { base = resolveServiceUrl(); } catch (e: any) { return err(e.message); }
    const body = { worry: a.worry, amountAtRisk: a.amountAtRisk, ...(a.maxCost ? { maxCost: a.maxCost } : {}), candidates: (a.candidates ?? []).map(safeSlim) };
    try {
      const r = proposeX402({ chain: "eip155:8453", url: `${base}/v1/plan`, method: "POST", body: body as any, maxAmount: MAX_ATOMIC });
      r.content = [{ type: "text", text: `Proposed a Hedge plan for "${a.worry.slice(0, 80)}" (${a.candidates?.length ?? 0} World candidates; up to 0.15 USDC, the service charges 0.10). After you approve, PayBox pays and returns the plan. Nothing has been paid or bought.` }];
      return r;
    } catch (e: any) { return err(`Hedge: ${e.message}`); }
  });
  return server;
}

serveStdio(createServer, { legacy: "reject" });
