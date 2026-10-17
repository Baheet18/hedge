// All runtime settings come from environment variables. Nothing secret lives in the repo.
export const config = {
  payTo: process.env.HEDGE_PAY_TO || "",                           // PLACEHOLDER: Baheet's Base USDC receiving address (0x...)
  price: process.env.HEDGE_PRICE || "$0.10",                       // per paid plan
  network: (process.env.HEDGE_NETWORK || "eip155:8453") as `${string}:${string}`, // Base mainnet USDC
  facilitatorUrl: process.env.X402_FACILITATOR_URL || "",          // optional custom facilitator; default = Coinbase CDP facilitator
  cdpKeyId: process.env.CDP_API_KEY_ID || "",
  cdpKeySecret: process.env.CDP_API_KEY_SECRET || "",
};
export const paidMode = () => !!config.payTo && (!!config.facilitatorUrl || (!!config.cdpKeyId && !!config.cdpKeySecret));
