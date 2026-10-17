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
  parsedBy: "ai" | "rules";
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
}
export interface FitJudgement { marketId: string; fit: Fit; side: "YES" | "NO"; covered: string; gaps: string[]; quote: string | null; by: "ai" | "rules" }
