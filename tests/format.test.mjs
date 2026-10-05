import assert from "node:assert/strict";
import { test } from "node:test";
import {
  basename, costText, metricsFor, percentage, printable,
  repositoryName, resetIn, tokens, usageColor,
  contextPercent, remainingTokens, remainingPercent, modelTitle, progressBar, resetDate,
} from "../hooks/format.mjs";

test("unknown readings differ from real zeroes", () => {
  assert.equal(tokens(undefined), "—");
  assert.equal(tokens(0), "0");
  assert.equal(percentage(undefined), "—");
  assert.equal(percentage(0), "0%");
  assert.equal(costText(undefined), "—");
  assert.equal(costText({ usd: 0 }), "$0.0000");
  for (const bad of [NaN, Infinity, -1, "10", null]) {
    assert.equal(tokens(bad), "—");
    assert.equal(percentage(bad), "—");
  }
});

test("progress bars preserve zero and unknown data and fill to their exact width", () => {
  assert.deepEqual(progressBar(37.5, 16), { filled: "██████", empty: "░░░░░░░░░░" });
  assert.deepEqual(progressBar(undefined, 8), { filled: "", empty: "········" });
  assert.deepEqual(progressBar(0, 4), { filled: "", empty: "░░░░" });
  assert.deepEqual(progressBar(100, 4), { filled: "████", empty: "" });
  assert.deepEqual(progressBar(110, 4), { filled: "████", empty: "" });
  assert.equal(remainingPercent(undefined), undefined);
  assert.equal(remainingPercent(37.5), 62.5);
  assert.equal(remainingPercent(110), 0);
  assert.equal(remainingTokens({ window: 200_000 }), undefined);
  assert.equal(remainingTokens({ tokens: 48_320, window: 200_000 }), 151_680);
  assert.equal(contextPercent({ tokens: 50_000, window: 200_000 }), 25);
});

test("model badges abbreviate known IDs and preserve custom model names", () => {
  assert.equal(modelTitle("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(modelTitle("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(modelTitle("claude-opus-4-20250514"), "Opus 4");
  assert.equal(modelTitle("claude-opus-4-6[1m]"), "Opus 4.6 · 1M");
  assert.equal(modelTitle("custom-provider-model"), "custom-provider-model");
  assert.equal(modelTitle(undefined), "—");
});

test("absolute reset dates identify the timezone and reject invalid readings", () => {
  assert.match(resetDate("2026-10-05T12:14:00Z", "Europe/Moscow"), /15:14.*Europe\/Moscow/);
  assert.equal(resetDate("invalid"), "—");
  assert.equal(resetDate(undefined), "—");
});

test("token counts remain exact and percentages keep one decimal", () => {
  assert.equal(tokens(48_321), "48 321");
  assert.equal(tokens(1_000_000), "1 000 000");
  assert.equal(percentage(23.5), "23.5%");
  assert.equal(percentage(7.000000000000001), "7%");
  assert.equal(costText({ usd: 0.18421 }), "$0.1842");
  assert.equal(usageColor(69.9), "green");
  assert.equal(usageColor(70), "yellow");
  assert.equal(usageColor(90), "red");
});

test("reset countdown handles minutes, hours, days and expired readings", () => {
  const now = Date.parse("2026-10-05T10:00:00Z");
  const later = (ms) => new Date(now + ms).toISOString();
  assert.equal(resetIn(later(30_000), now), "<1м");
  assert.equal(resetIn(later(60_000), now), "1м");
  assert.equal(resetIn(later(61_000), now), "2м");
  assert.equal(resetIn(later((2 * 60 + 14) * 60_000), now), "2ч 14м");
  assert.equal(resetIn(later((3 * 1440 + 5 * 60 + 7) * 60_000), now), "3д 5ч 7м");
  assert.equal(resetIn(later(0), now), "сейчас");
  assert.equal(resetIn(later(-60_000), now), "сейчас");
  assert.equal(resetIn("invalid", now), "—");
  assert.equal(resetIn(undefined, now), "—");
});

test("account windows match exact kinds, including when other windows come first", () => {
  const rows = metricsFor("sonnet", {
    context: { tokens: 48_320, window: 200_000, percent: 24.2 },
    rateLimits: [
      { kind: "seven_day_sonnet", percentUsed: 99 },
      { kind: "spend_limit", percentUsed: 110 },
      { kind: "seven_day", percentUsed: 62 },
      { kind: "five_hour", percentUsed: 37.5, resetsAt: "2026-10-05T12:14:00Z" },
    ],
    cost: { usd: 0.1842 },
  }, null, "/work/project", Date.parse("2026-10-05T10:00:00Z"));
  assert.equal(rows[0][1].value, "48 320/200 000 ток · 24.2%");
  assert.equal(rows[0][2].value, "37.5% · сброс 2ч 14м");
  assert.equal(rows[0][3].value, "62% · сброс —");
  assert.equal(rows[1][0].value, "$0.1842");
});

test("fresh and compacted sessions don't claim the context is empty", () => {
  const fresh = metricsFor("sonnet", { context: { window: 200_000 }, rateLimits: [] }, null, "/work/project", 0);
  assert.equal(fresh[0][1].value, "—/200 000 ток · —");
  assert.equal(fresh[0][2].value, "— · сброс —");
  assert.equal(fresh[0][3].value, "— · сброс —");
  const estimated = metricsFor("sonnet", { context: { tokens: 50_000, window: 200_000 } }, null, "/work/project", 0);
  assert.equal(estimated[0][1].value, "50 000/200 000 ток · 25%");
});

test("repository labels accept HTTPS, SSH, local repositories and Windows paths", () => {
  const repo = (remote, root = "/work/project") => ({ remote, root });
  assert.equal(repositoryName(repo("https://github.com/arsenii-cmd/Claude-mod.git")), "arsenii-cmd/Claude-mod");
  assert.equal(repositoryName(repo("git@github.com:arsenii-cmd/Claude-mod.git")), "arsenii-cmd/Claude-mod");
  assert.equal(repositoryName(repo("ssh://git@gitlab.example.com/group/subgroup/repo.git")), "group/subgroup/repo");
  assert.equal(repositoryName(repo("https://username:secret@github.com/owner/project.git")), "owner/project");
  assert.equal(repositoryName(repo(null)), "project");
  assert.equal(repositoryName(repo("/local/repository.git")), "project");
  assert.equal(repositoryName(repo("C:\\repos\\remote.git", "C:\\work\\project")), "project");
  assert.equal(basename("C:\\work\\project\\"), "project");
});

test("names cannot introduce terminal controls or additional rows", () => {
  assert.equal(printable("  feature\n/new\u202Ebranch  "), "feature/newbranch");
  assert.equal(printable("a\t  b"), "a b");
  assert.equal(printable("a".repeat(1000)).length, 200);
});
