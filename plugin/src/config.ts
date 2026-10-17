// Where the Hedge service lives. Set HEDGE_URL as an Environment variable in the PayBox portal
// (Variables & Secrets) after deploying; the default below is only a fallback. Also add its hostname under network hosts.
export const DEFAULT_SERVICE_URL = "https://hedge-paybox.vercel.app";

/** Validate and normalize a service base URL: https, port 443, no credentials, query or fragment. */
export function resolveServiceUrl(raw: string | undefined = process.env.HEDGE_URL): string {
  const value = (raw ?? "").trim() || DEFAULT_SERVICE_URL;
  let u: URL;
  try { u = new URL(value); } catch { throw new Error(`HEDGE_URL is not a valid URL: ${value}`); }
  const local = u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname); // dev only; x402 proposals still require https
  if ((u.protocol !== "https:" && !local) || (!local && u.port && u.port !== "443") || u.username || u.password || u.search || u.hash)
    throw new Error("HEDGE_URL must be an https:// origin (optionally with a path) on port 443, without credentials, query or fragment.");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}
