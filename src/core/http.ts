export async function getJson(url: string, opts: { headers?: Record<string, string>; ms?: number } = {}): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.ms ?? 3500);
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "hedge/1.0", ...opts.headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
export const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
export const parseArr = (v: unknown): any[] => { try { return Array.isArray(v) ? v : JSON.parse(String(v)); } catch { return []; } };
