import { expect, test } from "claude-code/testing";

const usage = {
  context: { tokens: 48_320, window: 200_000, percent: 24.2 },
  rateLimits: [
    { kind: "five_hour", percentUsed: 37.5, resetsAt: "2026-10-05T12:14:00Z" },
    { kind: "seven_day", percentUsed: 62, resetsAt: "2026-10-08T15:07:00Z" },
  ],
  cost: { usd: 0.1842 },
};

test("native terminal and Desktop validate cards, quota details and folding", async ($, on) => {
  on("session.model", () => ({ value: "claude-sonnet-4-6" }));
  on("session.usage", () => ({ value: usage }));
  on("session.cwd", () => ({ value: "/work/project" }));
  on("session.repo", () => ({ value: null }));
  on("clock.now", () => ({ value: Date.parse("2026-10-05T10:00:00Z") }));
  on("ui.render", () => ({ type: "Box", children: [] }));

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({
      plugin: "session-panel", component: "AbovePrompt", surface,
      props: {
        hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120,
        scroll: { offset: 0, bodyRows: 40 }, view: {},
      },
    });
    expect(await ui.find({ key: "session-panel-card-context" })).toBeDefined();
    expect(JSON.stringify(await ui.drawn())).toContain("62.5%");
    await ui.press({ key: "session-panel-detail-five_hour" });
    expect(JSON.stringify(await ui.drawn())).toContain("Общий лимит аккаунта");
    await ui.press({ key: "session-panel-close-detail" });
    expect(await ui.find({ key: "session-panel-details" })).toBeUndefined();
    await ui.press({ key: "session-panel-toggle" });
    expect(await ui.find({ key: "session-panel-card-context" })).toBeUndefined();
    expect(JSON.stringify(await ui.drawn())).toContain("Контекст");
    await ui.press({ key: "session-panel-toggle" });
    expect(await ui.find({ key: "session-panel-card-context" })).toBeDefined();
  }
});

test("native context details use the local estimate without paid token counting", async ($, on) => {
  let summaries = 0;
  on("session.model", () => ({ value: "claude-sonnet-4-6" }));
  on("session.usage", ($, e) => {
    if (e.breakdown) {
      expect(e.breakdown).toBe("summary");
      summaries += 1;
      return { value: { ...usage, context: { ...usage.context, breakdown: {
        totalTokens: 48_320, maxTokens: 200_000, rawMaxTokens: 200_000,
        percentage: 24.2, autocompactSource: "model-default", gridRows: [],
        model: "claude-sonnet-4-6", memoryFiles: [], mcpTools: [], agents: [],
        isAutoCompactEnabled: true, apiUsage: null,
        categories: [{ name: "Messages", tokens: 48_320, kind: "used", color: "cyan", isDeferred: false }],
      } } } };
    }
    return { value: usage };
  });
  on("session.cwd", () => ({ value: "/work/project" }));
  on("session.repo", () => ({ value: null }));
  on("clock.now", () => ({ value: 0 }));
  on("ui.render", () => ({ type: "Box", children: [] }));
  const ui = await $.ui.mount({ plugin: "session-panel", component: "AbovePrompt", surface: "terminal", props: {
    hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 40 }, view: {},
  } });
  expect(summaries).toBe(0);
  await ui.press({ key: "session-panel-detail-context" });
  expect(summaries > 0).toBe(true);
  expect(JSON.stringify(await ui.drawn())).toContain("Messages");
});
