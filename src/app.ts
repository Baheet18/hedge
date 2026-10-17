import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { plan, preview, type PlanInput } from "./core/plan.js";
import { llmAvailable } from "./core/llm.js";
import { config, paidMode } from "./config.js";

function parse(b: any): PlanInput | string {
  if (!b || typeof b !== "object") return "Send JSON: {worry, amountAtRisk, maxCost?, candidates?}.";
  if (typeof b.worry !== "string" || !b.worry.trim() || b.worry.length > 600) return "worry must be a non-empty string (≤600 chars).";
  const a = Number(b.amountAtRisk); if (!(a > 0 && a <= 1e6)) return "amountAtRisk must be a USD number between 0 and 1,000,000.";
  if (b.maxCost != null && !(Number(b.maxCost) > 0)) return "maxCost must be a positive USD number.";
  if (b.candidates != null && (!Array.isArray(b.candidates) || b.candidates.length > 25)) return "candidates must be an array of up to 25 World market objects.";
  return { worry: b.worry, amountAtRisk: a, maxCost: b.maxCost == null ? null : Number(b.maxCost), candidates: b.candidates ?? [] };
}

export function createApp() {
  const app = new Hono();
  app.get("/", (c) => c.json({
    product: "Hedge", tagline: "Tell it what you're worried about. It finds the market that pays you if it happens, or tells you there isn't one.",
    endpoints: { "POST /v1/plan": `paid (${config.price} USDC via x402${paidMode() ? "" : ", currently in unpaid dev mode"}): {worry, amountAtRisk, maxCost?, candidates?[World markets]}`, "POST /v1/preview": "free: {worry} → parsed worry + world_search queries", "GET /health": "status" },
    universe: "World (world.xyz) markets supplied by the agent from PayBox's World plugin. Without candidates, Polymarket is searched as a non-buyable reference.",
  }));
  app.get("/health", (c) => c.json({ ok: true, paid: paidMode(), network: config.network, price: config.price, ai: llmAvailable() }));
  if (paidMode()) {
    const fc = config.facilitatorUrl ? new HTTPFacilitatorClient({ url: config.facilitatorUrl }) : new HTTPFacilitatorClient(createFacilitatorConfig(config.cdpKeyId, config.cdpKeySecret));
    const rs = new x402ResourceServer(fc).register(config.network, new ExactEvmScheme());
    app.use(paymentMiddleware({ "POST /v1/plan": { accepts: [{ scheme: "exact", price: config.price, network: config.network, payTo: config.payTo, maxTimeoutSeconds: 120 }],
      description: "Hedge plan: the market that pays if your worry happens, cost to cover, what is and isn't covered", mimeType: "application/json" } }, rs));
  }
  app.post("/v1/plan", async (c) => {
    const inp = parse(await c.req.json().catch(() => null)); if (typeof inp === "string") return c.json({ error: inp }, 400);
    if (!paidMode()) c.header("x-hedge-mode", "unpaid-dev");
    // Paid mode: never charge for a keyword-only answer. A 503 makes the x402 middleware skip settlement.
    if (paidMode() && !llmAvailable()) return c.json({ error: "Hedge's AI is unavailable right now; you were not charged. Try again shortly." }, 503);
    try { const p = await plan(inp); if (paidMode() && p.aiDegraded) return c.json({ error: "Hedge's AI is over quota or timed out, so the plan would be keyword-only; you were not charged. Try again shortly.", headline: p.headline }, 503); return c.json(p); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 502); }
  });
  app.post("/v1/preview", async (c) => {
    const b: any = await c.req.json().catch(() => null);
    if (typeof b?.worry !== "string" || !b.worry.trim() || b.worry.length > 600) return c.json({ error: "worry must be a non-empty string (≤600 chars)." }, 400);
    const t0 = Date.now(); const p = await preview(b.worry.trim()); return c.json({ ...p, ms: Date.now() - t0 });
  });
  return app;
}

// Vercel may also treat this file as a Hono entrypoint; give it the app.
export default createApp();
