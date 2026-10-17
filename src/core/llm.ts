// Minimal Gemini JSON client. Key only in the x-goog-api-key header; never logged or returned.
// Free-tier keys allow ~20 requests/day per model, so calls rotate across models and an over-quota model cools down.
const list = (env: string | undefined, dflt: string) => (env || dflt).split(",").map((s) => s.trim()).filter(Boolean);
export const MODELS = {
  parse: list(process.env.HEDGE_PARSE_MODELS, "gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3-flash-preview"),
  judge: list(process.env.HEDGE_JUDGE_MODELS, "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest,gemini-3.6-flash,gemini-3-flash-preview"),
};
const cooldown = new Map<string, number>();
export const llmAvailable = () => !!process.env.GEMINI_API_KEY;

export async function geminiJson<T>(kind: keyof typeof MODELS, system: string, user: string, schema: object, timeoutMs = 6000, thinking = "low"): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("no GEMINI_API_KEY");
  const deadline = Date.now() + timeoutMs; let last: unknown = new Error("all AI models over quota");
  const models = MODELS[kind].filter((m) => (cooldown.get(m) ?? 0) < Date.now());
  for (const [i, model] of models.entries()) {
    const left = deadline - Date.now(); if (left < 800) break;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), i === models.length - 1 ? left : Math.max(left * 0.6, 3000));
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: schema, thinkingConfig: { thinkingLevel: thinking } } }),
      });
      if (!r.ok) { last = new Error(`Gemini ${model} HTTP ${r.status}`); if (r.status === 429) cooldown.set(model, Date.now() + 15 * 60_000); if (r.status === 404) cooldown.set(model, Date.now() + 864e5); continue; }
      const j: any = await r.json();
      const text = (j.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("");
      return JSON.parse(text) as T;
    } catch (e) { last = e; continue; }
    finally { clearTimeout(t); }
  }
  throw last;
}
