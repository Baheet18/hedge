// Vercel Node.js function: every path is rewritten here (see vercel.json).
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../src/app.js";
export const config = { maxDuration: 30 };
export default getRequestListener(createApp().fetch);
