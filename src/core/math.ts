// Pure-code pricing. Binary contracts pay $1 per share if the side wins.
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** Estimated per-share fee. World shows the real fee at buy time; default mirrors a 0.07*p*(1-p) taker curve. */
export function feePerShare(p: number, rate = Number(process.env.HEDGE_FEE_RATE ?? 0.07)): number {
  return Math.ceil(rate * p * (1 - p) * 10000) / 10000;
}
export interface Cost { price: number; bestPrice: number; walked?: boolean; maxLevel?: number; feePerShare: number; shares: number; cost: number; fees: number; payout: number; netIfHappens: number; coverage: number; costPctOfRisk: number; capped: boolean; liquidityCapped: boolean; availableShares: number | null }
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
  return { price: p, bestPrice: p, feePerShare: f, shares, cost, fees, payout, netIfHappens: round2(payout - cost), coverage: round2(payout / amountAtRisk), costPctOfRisk: round2((cost / amountAtRisk) * 100), capped, liquidityCapped, availableShares: availableShares ?? null };
}

/** Cover priced by walking an order book (asks, any order). price = average fill price for the shares quoted, bestPrice = the best ask,
 *  feePerShare = average est. fee, so cost = shares × (price + feePerShare). Stops where cover gets much dearer than the best ask
 *  (above best + max(3¢, 50%)) or at maxPrice all-in, so a thin book can't quietly turn into expensive cover. */
export function costFromBook(asks: Array<{ p: number; s: number }>, amountAtRisk: number, maxCost?: number | null, maxPrice = 0.7): Cost | null {
  const lv = asks.filter((a) => a.p > 0 && a.p < 1 && a.s > 0).sort((a, b) => a.p - b.p);
  if (!lv.length || !(amountAtRisk > 0)) return null;
  const best = lv[0]!.p; const ceiling = best + Math.max(0.03, best * 0.5);
  const target = Math.floor(amountAtRisk * 100) / 100;
  let shares = 0, notional = 0, fees = 0, capped = false, maxLevel = best;
  for (const a of lv) {
    const f = feePerShare(a.p); if (a.p > ceiling || a.p + f >= maxPrice) break;
    let take = Math.min(a.s, target - shares);
    if (maxCost != null && maxCost > 0 && notional + fees + take * (a.p + f) > maxCost) { take = Math.max(0, (maxCost - notional - fees) / (a.p + f)); capped = true; }
    take = Math.floor(take * 100) / 100; if (take <= 0) break;
    shares += take; notional += take * a.p; fees += take * f; maxLevel = a.p;
    if (capped || shares >= target - 1e-9) break;
  }
  if (shares <= 0) return null;
  shares = Math.round(shares * 100) / 100;
  const avg = notional / shares, fps = fees / shares, cost = round2(notional + fees), payout = round2(shares);
  return { price: Math.round(avg * 1e6) / 1e6, bestPrice: best, walked: true, maxLevel, feePerShare: fps, shares, cost, fees: round2(fees), payout, netIfHappens: round2(payout - cost), coverage: round2(payout / amountAtRisk),
    costPctOfRisk: round2((cost / amountAtRisk) * 100), capped, liquidityCapped: !capped && shares < target - 1e-9, availableShares: lv.reduce((t, a) => t + a.s, 0) };
}
