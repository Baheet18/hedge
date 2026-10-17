// Hedge paid demo. REAL MONEY: pays the 0.01 USDC x402 fee for one Hedge plan from YOUR PayBox agent wallet.
// It never buys a hedge (no world_buy_outcome) and never pays from Hedge's own receiving wallets.
//
// One-time setup (Windows PowerShell or any terminal):
//   npx @paybox-sh/sdk login
//   npx @paybox-sh/sdk connect
// Then:
//   npm run paid-demo                 # prefers your Base wallet named "eth1"
//   $env:HEDGE_CREDENTIAL="<id>"; npm run paid-demo   # pick a wallet explicitly (PowerShell)
import { PayboxClient } from "@paybox-sh/sdk";
import { btcEvent } from "../test/fixtures/world.js";

const SERVICE = (process.env.HEDGE_URL || "https://hedge-paybox.vercel.app").replace(/\/$/, "");
// Hedge's own receiving addresses. Paying from them would be paying yourself; refuse.
const NEVER_PAY_FROM = ["J2Xf2hyQLBxshKeGEm941D1azixiAtweVrWmnRuAeGDm", "0x6612a298c6ae56a4431d23119b71f3bdca2ec821"].map((a) => a.toLowerCase());
const PREFERRED = (process.env.HEDGE_WALLET_NAME || "eth1").toLowerCase();
const body = { worry: "Bitcoin drops below $55k", amountAtRisk: 100, candidates: [btcEvent] };
const parse = (b: unknown) => { if (typeof b !== "string") return b; try { return JSON.parse(b); } catch { return b; } };

const client: any = PayboxClient.fromConfig();
if (!client.canSign) { console.error("No local PayBox signing key. Run: npx @paybox-sh/sdk login   then   npx @paybox-sh/sdk connect"); process.exit(1); }

// ---- pick the paying wallet: Base first, preferring the one named eth1 ----
const { credentials } = await client.listCredentials();
const wallets = (credentials ?? []).map((c: any) => c.credential ?? c)
  .filter((c: any) => c?.credential_type === "wallet" && !c.disabled_at)
  .filter((c: any) => !NEVER_PAY_FROM.includes(String(c.metadata?.address ?? "").toLowerCase()));
const onBase = (c: any) => (c.metadata?.chains ?? []).some((x: string) => /base|eip155:8453|evm|ethereum/i.test(String(x)));
const ranked = process.env.HEDGE_CREDENTIAL ? wallets.filter((c: any) => c.id === process.env.HEDGE_CREDENTIAL)
  : [...wallets.filter((c: any) => onBase(c) && String(c.name ?? "").toLowerCase() === PREFERRED), ...wallets.filter((c: any) => onBase(c) && String(c.name ?? "").toLowerCase() !== PREFERRED), ...wallets.filter((c: any) => !onBase(c))];
const w = ranked[0];
if (!w) { console.error("No granted PayBox wallet found (Hedge's own receiving wallets are excluded). Grant a Base wallet to this connector in the PayBox app."); process.exit(1); }
console.log(`Paying from: ${w.name ?? "(unnamed)"} ${w.metadata?.address ?? ""} [${(w.metadata?.chains ?? []).join(", ")}] credential ${w.id}`);
console.log(`Service: ${SERVICE}/v1/plan  (fee 0.01 USDC; nothing is bought)\n`);

// ---- 1. PayBox pays the x402 fee and fetches the plan (signed in-process with your local key) ----
console.log("1) use_service → Hedge /v1/plan ...");
const started = await client.useService({ credentialId: w.id, url: `${SERVICE}/v1/plan`, method: "POST", body }, { autoSign: true, waitForApproval: { intervalMs: 2000, timeoutMs: 300_000 } });
let req = started.response;
console.log(`   PayBox request ${req?.request_id}: ${req?.status}${req?.error ? ` (${req.error})` : ""}`);

// ---- 2. Poll get_request until it finishes ----
const TERMINAL = ["success", "error", "denied", "expired", "cancelled"];
for (let i = 0; req?.request_id && !TERMINAL.includes(req.status) && i < 100; i++) {
  if (req.status === "pending_approval" && i % 5 === 0) console.log("   Waiting for your approval in the PayBox app...");
  await new Promise((r) => setTimeout(r, 3000));
  req = await client.getRequest(req.request_id);
}
const value: any = req?.output?.value ?? req?.output ?? {};
const httpStatus = value.response?.status ?? value.resource?.status;
const plan: any = parse(value.response?.body ?? value.resource?.body);
const payment = value.payment ?? value.settlement ?? null;
const tx = payment?.transaction ?? payment?.tx_hash ?? payment?.txHash ?? value.tx_hash ?? null;
const network = payment?.network ?? "";
const explorer = tx ? (/solana/.test(network) ? `https://solscan.io/tx/${tx}` : `https://basescan.org/tx/${tx}`) : null;

console.log(`\n2) Request ${req?.request_id}: ${req?.status}; Hedge answered HTTP ${httpStatus ?? "?"}`);
console.log(`   Payment: ${JSON.stringify(payment)}`);
if (explorer) console.log(`   Tx: ${explorer}`);
if (req?.status !== "success") { console.log("\nNot successful. Do NOT rerun to retry until you've checked the request above:", JSON.stringify(req, null, 2)); process.exit(1); }

// ---- 3. Print the plan (no buying) ----
console.log("\n3) Hedge plan:");
console.log(`   ${plan?.headline ?? "(no headline)"}`);
if (plan?.best) console.log(`   Best: ${plan.best.market.title} | ${plan.best.side} | fit ${plan.best.fit} | cost $${plan.best.cost?.cost} → pays $${plan.best.cost?.payout}`);
if (plan?.best?.rulesQuote) console.log(`   Rules: "${plan.best.rulesQuote}"`);
for (const g of plan?.best?.whatsNotCovered ?? []) console.log(`   Not covered: ${g}`);
if (plan?.execute) console.log(`   Suggested (NOT executed): ${plan.execute.tool} ${plan.execute.side} ${plan.execute.marketId} $${plan.execute.amountUsd}`);
console.log("\nDone. Only the 0.01 USDC fee was spent; no hedge was bought. Add this row to the README table:");
console.log(`| ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC | ${w.name ?? w.id} | ${network || "?"} | 0.01 USDC | ${explorer ?? tx ?? "?"} | ${req.request_id} |`);
