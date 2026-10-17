// Vercel Node.js function: every path is rewritten here (see vercel.json).
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../src/app.js";
export const config = { maxDuration: 30 };
const app = createApp();
// Vercel terminates TLS; restore https so the x402 challenge advertises the real resource URL.
export default getRequestListener((req) => {
  const u = new URL(req.url);
  if (u.protocol === "http:" && u.hostname !== "localhost") { u.protocol = "https:"; return app.fetch(new Request(u, req)); }
  return app.fetch(req);
});
