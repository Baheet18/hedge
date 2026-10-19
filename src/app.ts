import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { plan, preview, freeMatch, type PlanInput } from "./core/plan.js";
import { llmAvailable } from "./core/llm.js";
import { config, paidMode, networks } from "./config.js";
import { handleUpdate, tgSecret, tgToken, ensureWebhook } from "./telegram.js";

function parse(b: any): PlanInput | string {
  if (!b || typeof b !== "object") return "Send JSON: {worry, amountAtRisk, maxCost?, candidates?}.";
  if (typeof b.worry !== "string" || !b.worry.trim() || b.worry.length > 600) return "worry must be a non-empty string (≤600 chars).";
  const a = Number(b.amountAtRisk); if (!(a > 0 && a <= 1e6)) return "amountAtRisk must be a USD number between 0 and 1,000,000.";
  if (b.maxCost != null && !(Number(b.maxCost) > 0)) return "maxCost must be a positive USD number.";
  if (b.candidates != null && (!Array.isArray(b.candidates) || b.candidates.length > 25)) return "candidates must be an array of up to 25 World market objects.";
  return { worry: b.worry, amountAtRisk: a, maxCost: b.maxCost == null ? null : Number(b.maxCost), candidates: b.candidates ?? [] };
}

/** Mirror the v2 PAYMENT-REQUIRED header into the 402 JSON body, so clients that read the body (not just the header) see a complete challenge. */
export const mirrorChallenge = async (c: any, next: () => Promise<void>) => {
  await next();
  if (c.res?.status !== 402) return;
  const h = c.res.headers.get("payment-required"); if (!h) return;
  try { const pr = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    const sig = c.req.header("payment-signature"), xp = c.req.header("x-payment");
    if (sig || xp) { let net = "?", ver = "?", from = "?";
      try { const pl = JSON.parse(Buffer.from(sig || xp, "base64").toString("utf8")); ver = pl.x402Version; net = pl.accepted?.network ?? pl.network; from = pl.payload?.authorization?.from ?? "(svm)"; } catch { net = "undecodable"; }
      console.warn("[hedge-x402] proof rejected", JSON.stringify({ header: sig ? "PAYMENT-SIGNATURE" : "X-PAYMENT", ver, net, from, sigLen: (sig || xp).length, error: pr.error ?? null, method: c.req.method })); }
    const headers = new Headers(c.res.headers); headers.set("content-type", "application/json"); headers.delete("content-length");
    c.res = new Response(JSON.stringify(pr), { status: 402, headers }); } catch { /* keep original */ }
};

export function createApp() {
  const app = new Hono();
  if (tgToken() && process.env.VERCEL) void ensureWebhook(); // on cold start: make sure button taps (callback_query) are delivered
  app.get("/", (c) => c.json({
    product: "Hedge", tagline: "Tell it what you're worried about. It finds the market that pays you if it happens, or tells you there isn't one.",
    endpoints: { "POST /v1/plan": `paid (${config.price} USDC via x402${paidMode() ? "" : ", currently in unpaid dev mode"}): {worry, amountAtRisk, maxCost?, candidates?[World markets]}`, "POST /v1/match": "free: {worry, amountAtRisk?, candidates?} → best match + price + cost to cover (no candidates → world_search queries)", "POST /v1/preview": "free: {worry} → parsed worry + world_search queries", "GET /health": "status" },
    universe: "Venue-agnostic: World markets supplied by the agent (buyable through PayBox) plus Polymarket, searched on every request (link only).",
  }));
  app.post("/api/telegram", async (c) => {
    if (!tgToken() || c.req.header("x-telegram-bot-api-secret-token") !== tgSecret()) return c.json({ ok: false }, 401);
    const u = await c.req.json().catch(() => null);
    await ensureWebhook();
    await handleUpdate(u).catch((e) => console.error("[hedge-tg]", e?.message));
    return c.json({ ok: true });
  });
  app.get("/health", (c) => c.json({ ok: true, paid: paidMode(), network: config.network, networks: networks(), price: config.price, ai: llmAvailable() }));
  if (paidMode()) {
    const fc = config.facilitatorUrl ? new HTTPFacilitatorClient({ url: config.facilitatorUrl }) : new HTTPFacilitatorClient(createFacilitatorConfig(config.cdpKeyId, config.cdpKeySecret));
    const rs = new x402ResourceServer(fc);
    if (config.payTo) rs.register(config.network, new ExactEvmScheme());
    if (config.payToSolana) rs.register(config.solanaNetwork, new ExactSvmScheme());
    const accepts = [
      ...(config.payToSolana ? [{ scheme: "exact", price: config.price, network: config.solanaNetwork, payTo: config.payToSolana, maxTimeoutSeconds: 600 }] : []),
      ...(config.payTo ? [{ scheme: "exact", price: config.price, network: config.network, payTo: config.payTo, maxTimeoutSeconds: 600 }] : []),
    ];
    const route = { accepts: accepts as any,
      description: "Hedge plan: the market that pays if your worry happens, cost to cover, what is and isn't covered", mimeType: "application/json" };
    app.use("/v1/plan", mirrorChallenge);
    app.use(paymentMiddleware({ "POST /v1/plan": route, "GET /v1/plan": route } as any, rs));
  }
  app.get("/v1/plan", (c) => c.json({ error: "Use POST with {worry, amountAtRisk, candidates?}. You were not charged." }, 400));
  app.post("/v1/plan", async (c) => {
    const inp = parse(await c.req.json().catch(() => null)); if (typeof inp === "string") return c.json({ error: inp }, 400);
    if (!paidMode()) c.header("x-hedge-mode", "unpaid-dev");
    // Paid mode: never charge for a keyword-only answer. A 503 makes the x402 middleware skip settlement.
    if (paidMode() && !llmAvailable()) return c.json({ error: "Hedge's AI is unavailable right now; you were not charged. Try again shortly." }, 503);
    try { const p = await plan(inp); if (paidMode() && p.aiDegraded) return c.json({ error: "Hedge's AI is over quota or timed out, so the plan would be keyword-only; you were not charged. Try again shortly.", headline: p.headline }, 503); return c.json(p); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 502); }
  });
  app.post("/v1/match", async (c) => {
    const b: any = await c.req.json().catch(() => null);
    const inp = parse(b && typeof b === "object" && b.amountAtRisk == null ? { ...b, amountAtRisk: 100 } : b); if (typeof inp === "string") return c.json({ error: inp }, 400);
    try { return c.json(await freeMatch(inp)); } catch (e: any) { return c.json({ error: String(e?.message ?? e) }, 502); }
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
