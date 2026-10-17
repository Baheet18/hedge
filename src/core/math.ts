// Pure-code pricing. Binary contracts pay $1 per share if the side wins.
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** Estimated per-share fee. World shows the real fee at buy time; default mirrors a 0.07*p*(1-p) taker curve. */
export function feePerShare(p: number, rate = Number(process.env.HEDGE_FEE_RATE ?? 0.07)): number {
  return Math.ceil(rate * p * (1 - p) * 10000) / 10000;
}
export interface Cost { price: number; feePerShare: number; shares: number; cost: number; fees: number; payout: number; netIfHappens: number; coverage: number; costPctOfRisk: number; capped: boolean; liquidityCapped: boolean; availableShares: number | null }
/** Cover amountAtRisk C: buy C shares at price p (pays $C if the worry happens). maxCost caps spend and shrinks coverage. */
export function costToCover(p: number, amountAtRisk: number, maxCost?: number | null, availableShares?: number | null): Cost {
  if (!(p > 0 && p < 1)) throw new Error(`price must be between 0 and 1, got ${p}`);
  if (!(amountAtRisk > 0)) throw new Error("amountAtRisk must be positive");
  const f = feePerShare(p); const per = p + f;
  let shares = Math.floor(amountAtRisk * 100) / 100; let capped = false;
  if (maxCost != null && maxCost > 0 && shares * per > maxCost) { shares = Math.floor((maxCost / per) * 100) / 100; capped = true; }
  let liquidityCapped = false;
  if (availableShares != null && availableShares >= 0 && shares > availableShares) { shares = Math.floor(availableShares * 100) / 100; liquidityCapped = true; }
  const cost = round2(shares * per), fees = round2(shares * f), payout = round2(shares);
  return { price: p, feePerShare: f, shares, cost, fees, payout, netIfHappens: round2(payout - cost), coverage: round2(payout / amountAtRisk), costPctOfRisk: round2((cost / amountAtRisk) * 100), capped, liquidityCapped, availableShares: availableShares ?? null };
}
