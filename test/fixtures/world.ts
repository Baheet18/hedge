// Realistic World-format inputs (shape as returned by world_get_events / world_get_markets). Values are illustrative.
export const btcEvent = {
  ticker: "WXBTCYR-26LOW", title: "How low will Bitcoin go in 2026?",
  settlementSources: [{ name: "Chainlink", url: "https://data.chain.link/streams/btc-usd" }],
  markets: [
    { ticker: "WXBTCYR-26LOW-B55K", title: { template: "Bitcoin {threshold} in 2026?", tokens: { threshold: { value: "below $55,000" } } },
      rulesPrimary: { template: "If the Bitcoin price trades {threshold} at any time before {deadline}, as reported by {source}, then the market resolves to Yes.", tokens: { threshold: { value: "below $55,000" }, deadline: { value: "December 31, 2026, 11:59 PM ET" }, source: { value: "the Chainlink BTC/USD data stream" } } },
      rulesSecondary: { template: "Any single print {threshold} on the source counts. Otherwise the market resolves to No.", tokens: { threshold: { value: "below $55,000" } } },
      closeTime: "2027-01-01T04:59:00Z", yesBid: 0.12, yesAsk: 0.126, noBid: 0.874, noAsk: 0.88, yesAskQty: 2000,
      accounts: { CASHvDm9wTXnr4Lz1m8iNRS2AMvGqxmCzPgc4bW6zj1U: { marketLedger: "LdgrB55K", yesMint: "YESb55kMint1111111111111111111111111111111", noMint: "NOb55kMint11111111111111111111111111111111", isInitialized: true } } },
    { ticker: "WXBTCYR-26LOW-B40K", title: { template: "Bitcoin {threshold} in 2026?", tokens: { threshold: { value: "below $40,000" } } },
      rulesPrimary: { template: "If the Bitcoin price trades {threshold} at any time before {deadline}, as reported by {source}, then the market resolves to Yes.", tokens: { threshold: { value: "below $40,000" }, deadline: { value: "December 31, 2026, 11:59 PM ET" }, source: { value: "the Chainlink BTC/USD data stream" } } },
      closeTime: "2027-01-01T04:59:00Z", yesAsk: 0.04, noAsk: 0.97, yesMint: "YESb40k", noMint: "NOb40k" },
  ],
};
export const fedExactly2 = { ticker: "WXFEDHIKE-26-E2", title: "Exactly 2 Fed rate hikes in 2026?", closeTime: "2026-12-10T19:00:00Z",
  rulesPrimary: { template: "If the FOMC raises the target range exactly {n} times in 2026, then the market resolves to Yes.", tokens: { n: { value: "2" } } },
  settlementSources: ["Federal Reserve"], yesAsk: 0.05, noAsk: 0.96, yesMint: "YESfed2", noMint: "NOfed2" };
