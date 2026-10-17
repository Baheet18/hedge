// Run 10 real worries end to end (live Gemini + reference search). Usage: GEMINI_API_KEY=... pnpm worries [world-candidates.json]
import { readFileSync, writeFileSync } from "node:fs";
import { plan } from "../src/core/plan.js";
export const WORRIES: [string, number][] = [
  ["I'm paid in naira and my rent is in dollars. I'm worried USD/NGN goes past 2,000 before the end of the year.", 500],
  ["A hurricane making landfall in Florida before December would wreck my rental property.", 2000],
  ["If the US goes into a recession in 2026 I'll probably lose my job.", 3000],
  ["My savings are in bitcoin and I'm worried BTC falls below $80,000 by December 31.", 1000],
  ["If the Fed doesn't cut rates at the December meeting my mortgage refinance falls through.", 800],
  ["If a Democrat wins the 2028 US presidential election my defense stocks will tank.", 1500],
  ["I'm worried oil spikes above $100 a barrel this year and my delivery business eats the fuel cost.", 600],
  ["If US inflation (CPI) comes in hot next month my bond fund drops.", 400],
  ["My flight business suffers if a government shutdown happens before November.", 1000],
  ["I'm worried it rains on my outdoor wedding in Lagos on November 14.", 300],
];
const cands = process.argv[2] && process.argv[2] !== "-" ? JSON.parse(readFileSync(process.argv[2]!, "utf8")) : undefined;
const out: any[] = [];
const only = process.env.ONLY ? process.env.ONLY.split(",").map(Number) : null;
for (const [i, [w, a]] of WORRIES.entries()) {
  if (only && !only.includes(i)) continue;
  const t0 = Date.now();
  try { const p = await plan({ worry: w, amountAtRisk: a, candidates: cands }); out.push(p);
    console.log(`\n[${Date.now() - t0}ms] ${w}\n  → ${p.headline}\n  parsed(${p.worry.parsedBy}): ${p.worry.summary} | q=${p.worry.searchQueries.join(" / ")}`);
    const o = p.best ?? p.alternatives[0]; if (o) console.log(`  ${p.best ? "best" : "closest"}: [${o.fit}] ${o.side} "${o.market.title}" p=${o.cost?.price} cost=${o.cost?.cost}\n  quote: ${o.rulesQuote}\n  gaps: ${o.whatsNotCovered.join(" | ")}`);
  } catch (e) { console.log(`\n${w}\n  ERROR ${(e as Error).message}`); }
}
writeFileSync("scripts/last-run.json", JSON.stringify(out, null, 2));
