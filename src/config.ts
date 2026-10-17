// All runtime settings come from environment variables. Nothing secret lives in the repo.
export const config = {
  payTo: process.env.HEDGE_PAY_TO || "",                           // PLACEHOLDER: Baheet's Base USDC receiving address (0x...)
  price: process.env.HEDGE_PRICE || "$0.01",                       // per paid plan
  network: (process.env.HEDGE_NETWORK || "eip155:8453") as `${string}:${string}`, // Base mainnet USDC
  payToSolana: process.env.HEDGE_PAY_TO_SOLANA || "",              // optional Solana USDC receive address; enables the Solana accept
  solanaNetwork: (process.env.HEDGE_SOLANA_NETWORK || "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") as `${string}:${string}`,
  facilitatorUrl: process.env.X402_FACILITATOR_URL || "",          // optional custom facilitator; default = Coinbase CDP facilitator
  cdpKeyId: process.env.CDP_API_KEY_ID || "",
  cdpKeySecret: process.env.CDP_API_KEY_SECRET || "",
};
export const paidMode = () => !!(config.payTo || config.payToSolana) && (!!config.facilitatorUrl || (!!config.cdpKeyId && !!config.cdpKeySecret));
/** Networks the paid plan accepts, Solana first when a Solana payTo is configured. */
export const networks = (): string[] => [...(config.payToSolana ? [config.solanaNetwork] : []), ...(config.payTo ? [config.network] : [])];
