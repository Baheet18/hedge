export type Fit = "exact" | "close" | "loose" | "none";
export interface Worry {
  text: string;
  summary: string;              // one line: the bad event
  category: string;             // fx | weather | macro | crypto | politics | sports | rates | other
  subject: string;              // e.g. "USD/NGN exchange rate", "hurricane landfall"
  direction: "above" | "below" | "happens" | "unknown";
  threshold: number | null;     // e.g. 2000
  unit: string | null;          // e.g. "NGN per USD"
  location: string | null;      // e.g. "Texas"
  deadline: string | null;      // ISO date the worry must happen by
  windowStart: string | null;   // ISO date the exposure starts (trip start)
  searchQueries: string[];      // for world_search / reference search
  keyTerms: string[];
  isBet: boolean;               // speculation ("put money on the Knicks"), not protection against a loss
  parsedBy: "ai" | "regex" | "rules"; // regex = confident pattern parse (no AI needed); rules = fallback
  timeframeGiven?: boolean;     // the user stated a time (code check, not the AI)
  assumptions?: string[];       // plain notes on anything assumed (e.g. no end date), shown to the user
}
export interface Candidate {
  source: "world" | "reference";
  venue: string;                // "world" | "kalshi" | "polymarket" | ...
  marketId: string;
  title: string;
  rules: string;
  closeTime: string | null;
  yesAsk: number | null; noAsk: number | null;
  yesBid: number | null; noBid: number | null;
  yesMint: string | null; noMint: string | null;
  url: string | null;
  sources: string[];             // who settles it (e.g. Chainlink, NHC)
  askQty: { yes: number | null; no: number | null }; // shares available at the ask (from world_orderbook)
  tokenIds?: { yes: string | null; no: string | null };
  fee?: import("./math.js").FeeModel; // venue taker fee; undefined = default estimate (World) // Polymarket CLOB token ids, for a depth check
}
export interface FitJudgement { marketId: string; fit: Fit; side: "YES" | "NO"; covered: string; gaps: string[]; quote: string | null; by: "ai" | "rules" }
