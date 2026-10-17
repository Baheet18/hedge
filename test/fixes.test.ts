import { test } from "node:test";
import assert from "node:assert/strict";
import { topicQueries, topicBoost } from "../src/core/plan.js";
import { codeChecks, cleanGaps } from "../src/core/fit.js";
import { rulesParse } from "../src/core/worry.js";
import type { Candidate } from "../src/core/types.js";

const NOW = new Date("2026-10-17T11:00:00Z");
const cand = (title: string, closeTime: string): Candidate => ({ source: "reference", venue: "polymarket", marketId: title, title, rules: "", closeTime, yesAsk: 0.5, noAsk: 0.5, yesBid: null, noBid: null, yesMint: null, noMint: null, url: "", sources: [], askQty: { yes: null, no: null } } as Candidate);
const FED = "I own Nvidia stock and lose if the Fed doesn't cut rates at the next meeting, cover $800";

test("Fed worries search Polymarket's own wording", () => {
  assert.deepEqual(topicQueries(FED), ["fed decision", "fomc"]);
  assert.deepEqual(topicQueries("Bitcoin below 55k"), []);
});
test("Fed 'no cut at next meeting' ranks October 'no change' first", () => {
  const oct = "2026-10-29T03:59:00Z", dec = "2026-12-10T04:59:00Z";
  const s = (t: string, c: string) => topicBoost(FED, cand(t, c), NOW);
  const noOct = s("Will there be no change in Fed interest rates after the October 2026 meeting?", oct);
  assert.ok(noOct > s("Will the Fed decrease interest rates by 25 bps after the October 2026 meeting?", oct));
  assert.ok(noOct > s("Will there be no change in Fed interest rates after the December 2026 meeting?", dec));
  assert.ok(noOct > s("Will one person dissent the October Fed decision?", oct));
});
test("Timing copy: days when under two weeks, no duplicate cover-ends bullet", () => {
  const w = rulesParse("Oil going above $100 would wreck my delivery business, cover $1,500", NOW);
  const r = codeChecks(w, cand("Will WTI hit $100 on October 19?", "2026-10-20T03:59:00Z"), { marketId: "x", fit: "close", side: "YES", covered: "", gaps: [], quote: null, by: "ai" }, NOW);
  assert.ok(r.gaps.some((g) => /only 2 days away/.test(g)), r.gaps.join("|"));
  assert.ok(!r.gaps.some((g) => /weeks away/.test(g)));
  assert.equal(r.gaps.filter((g) => /^Cover ends|^Timing/.test(g)).length, 1);
});
test("'single day vs whole month' gap dropped when the worry names no window", () => {
  const w = rulesParse("Oil going above $100 would wreck my delivery business", NOW);
  const c = cand("Will WTI hit $100 on October 19?", "2026-10-20T03:59:00Z");
  assert.deepEqual(cleanGaps(w, c, ["Only covers a single day instead of the whole month."]), []);
  const w2 = rulesParse("Oil above $100 this month would wreck my business", NOW);
  assert.equal(cleanGaps({ ...w2, deadline: null }, c, ["Only covers a single day instead of the whole month."]).length, 1);
});
test("'next Fed meeting' resolves to the October 28 FOMC decision", async () => {
  const { fedNextMeeting } = await import("../src/core/worry.js");
  assert.equal(fedNextMeeting(FED, NOW), "2026-10-28");
  assert.equal(fedNextMeeting("Bitcoin next meeting", NOW), null);
});
