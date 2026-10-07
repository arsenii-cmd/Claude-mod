import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pets } from "../hooks/pets.mjs";

const execute = promisify(execFile);
let moduleId = 0;

async function harness(run, graphics = false) {
  // Each instance gets the same isolation as a separately loaded hooks module.
  const { register } = await import(`../hooks/register.mjs?test=${moduleId++}`);
  const hooks = new Map();
  const state = {
    now: Date.parse("2026-10-05T10:00:00Z"),
    model: "claude-sonnet-4-6",
    cwd: "/work/project",
    repo: { root: "/work/project", remote: "git@github.com:owner/project.git" },
    usage: {
      context: { tokens: 48_320, window: 200_000, percent: 24.2 },
      rateLimits: [
        { kind: "five_hour", percentUsed: 37.5, resetsAt: "2026-10-05T12:14:00Z" },
        { kind: "seven_day", percentUsed: 62, resetsAt: "2026-10-08T15:07:00Z" },
      ],
      cost: { usd: 0.1842 },
    },
    processCalls: [], usageCalls: [], timers: [], cancelled: 0, redraws: 0, blits: [],
  };
  const element = (type) => (props) => ({ type, ...props });
  const $ = {
    session: {
      model: async () => state.model,
      usage: async (...args) => {
        assert.ok(args.length === 0 || args[0]?.breakdown === "summary", "never request a paid breakdown");
        state.usageCalls.push(args[0]);
        if (args[0]?.breakdown === "summary") return {
          ...state.usage,
          context: { ...state.usage.context, breakdown: state.breakdown },
        };
        return state.usage;
      },
      cwd: async () => state.cwd,
      repo: async () => state.repo,
    },
    clock: {
      now: async () => state.now,
      every: (ms, callback) => {
        state.timers.push({ ms, callback });
        return { cancel: () => { state.cancelled += 1; } };
      },
    },
    ui: {
      resolve: () => ({ Box: element("Box"), Text: element("Text"), Button: element("Button"), ...(graphics ? { Image: element("Image") } : {}) }),
      blit: async (args) => { state.blits.push(args); return state.blitResult ?? {}; },
      invalidate: (event) => { assert.equal(event, "ui.render"); state.redraws += 1; },
    },
    process: {
      run: async (argv, options) => {
        state.processCalls.push({ argv, options });
        return run ? run(argv, options) : { exitCode: 0, stdout: "main\n", stderr: "" };
      },
    },
  };
  register((name, matcher, hook) => { hooks.set(name, hook ?? matcher); });
  const existing = { type: "Text", children: "another mod" };
  async function fire(name, event = {}, result = {}) {
    let forwarded = 0;
    const next = async (received) => {
      assert.equal(received, event, "observing hooks must forward the original event");
      forwarded += 1;
      return result;
    };
    try {
      return await hooks.get(name)($, event, next);
    } finally {
      assert.equal(forwarded, 1, "the downstream hook must run exactly once");
    }
  }
  const render = (props = {}, surface = "terminal") => fire("ui.render", {
    component: "AbovePrompt", surface,
    requestId: graphics ? "test-band" : undefined,
    props: { hasSurvey: false, bodyColumns: 80, maxRows: 5, ...props },
  }, existing);
  return { $, state, existing, fire, render };
}

function text(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" ? node.type === "Button" ? node.label : text(node.children) : "";
}

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object") return [];
  return [node, ...elements(node.children)];
}

function press(tree, key) {
  const button = elements(tree).find((node) => node.type === "Button" && node.key === key);
  assert.ok(button, `missing button ${key}`);
  return button.onPress();
}

const petProps = { bodyColumns: 160, maxRows: 40 };
function assertScene(tree, id) {
  const image = elements(tree).find(node => node.key === "session-panel-pet-image");
  assert.equal(image?.alt, `Clawd: ${pets.find(pet => pet.id === id).name}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test("both modes keep typing across tool changes, errors, denial and long turns", async () => {
  for (const collection of [false, true]) {
    const h = await harness(undefined, true);
    if (collection) press(await h.render(petProps), "session-panel-pet-mode");
    await h.fire("turn.start", { turnId: "main-turn" });
    for (const [tool, args, result] of [
      ["Read", {}, {}], ["Write", {}, {}], ["Grep", {}, {}],
      ["Bash", { command: "npm test" }, { isError: true, text: "test failed" }],
      ["Bash", { command: "git push" }, { deny: "not allowed" }],
      ["WebFetch", {}, { text: "HTTP/2 429", result: {} }],
    ]) {
      await h.fire("tool.call", { tool, ...args }, result);
      h.state.now += 120_000;
      assertScene(await h.render({ ...petProps, isWorking: true }), "working-typing");
    }
    await assert.rejects(h.fire("tool.call", { tool: "Bash" }, Promise.reject(new Error("tool crashed"))), /tool crashed/);
    assertScene(await h.render(petProps), "working-typing");
    await h.fire("turn.complete", { turnId: "main-turn", reason: "answer" });
    assertScene(await h.render({ ...petProps, isWorking: true }), "celebrating", "a stale busy render must not revive the completed turn");
  }
});

test("each completion reason is held then expires; a new turn interrupts the outcome", async () => {
  const h = await harness(undefined, true);
  press(await h.render(petProps), "session-panel-pet-mode");
  for (const [reason, scene] of Object.entries({ answer: "celebrating", error: "error", aborted: "shrug", refusal: "skeptical" })) {
    await h.fire("turn.start", { turnId: reason });
    await h.fire("turn.complete", { turnId: reason, reason, isAborted: reason === "aborted" });
    assertScene(await h.render(petProps), scene);
    h.state.now += 7_999;
    assertScene(await h.render(petProps), scene);
    h.state.now += 1;
    assert.ok(text(await h.render(petProps)).includes("Ожидает запроса"));
  }
  await h.fire("turn.start", { turnId: "last" });
  await h.fire("turn.complete", { turnId: "last", reason: "answer" });
  await h.fire("turn.start", { turnId: "next" });
  assertScene(await h.render(petProps), "working-typing");
});

test("reload hydrates busy state from the host; host end and delayed completion agree", async () => {
  const h = await harness(undefined, true);
  assertScene(await h.render({ ...petProps, isWorking: true }), "working-typing");
  h.state.now += 120_000;
  assertScene(await h.render({ ...petProps, isWorking: true, hasSurvey: false }), "working-typing");
  assert.ok(text(await h.render({ ...petProps, isWorking: false })).includes("Ожидает запроса"));
  await h.fire("turn.start", { turnId: "delayed" });
  await h.render({ ...petProps, isWorking: true });
  await h.render({ ...petProps, isWorking: false });
  await h.fire("turn.complete", { turnId: "delayed", reason: "error" });
  assertScene(await h.render({ ...petProps, isWorking: false }), "error");
  assertScene(await h.render({ ...petProps, isWorking: true }), "working-typing");
});

test("parallel questions stay waiting until every question resolves, including failure", async () => {
  const h = await harness(undefined, true);
  await h.fire("turn.start", { turnId: "questions" });
  const first = deferred(), second = deferred(), command = deferred();
  const one = h.fire("tool.call", { tool: "AskUserQuestion", tool_use_id: "q1" }, first.promise);
  const two = h.fire("tool.call", { tool: "AskUserQuestion", tool_use_id: "q2" }, second.promise);
  const bash = h.fire("tool.call", { tool: "Bash", tool_use_id: "b1" }, command.promise);
  assertScene(await h.render(petProps), "working-oncall");
  h.state.now += 120_000;
  command.resolve({ result: "ok" }); await bash;
  assertScene(await h.render(petProps), "working-oncall");
  first.resolve({ result: "answer" }); await one;
  assertScene(await h.render(petProps), "working-oncall");
  const rejection = assert.rejects(two, /cancelled/);
  second.reject(new Error("cancelled")); await rejection;
  assertScene(await h.render(petProps), "working-typing");
});

test("old tools and turn completions cannot overwrite a new turn or a cleared session", async () => {
  const h = await harness(undefined, true);
  await h.fire("turn.start", { turnId: "old" });
  const delayedTool = deferred(), delayedTurn = deferred();
  const tool = h.fire("tool.call", { tool: "AskUserQuestion", tool_use_id: "old-q" }, delayedTool.promise);
  const completion = h.fire("turn.complete", { turnId: "old", reason: "answer" }, delayedTurn.promise);
  await h.render(petProps);
  await h.fire("session.end", { reason: "clear" });
  delayedTool.resolve({ isError: true }); await tool;
  delayedTurn.resolve({ text: "stale" }); await completion;
  assert.ok(text(await h.render(petProps)).includes("Ожидает запроса"));
  await h.fire("turn.start", { turnId: "new" });
  await h.fire("turn.complete", { turnId: "old", reason: "error" });
  assertScene(await h.render(petProps), "working-typing");
  await h.fire("turn.complete", { turnId: "new", reason: "answer" });
  await h.fire("turn.complete", { turnId: "new", reason: "error" });
  assertScene(await h.render(petProps), "celebrating");
});

test("subagents and hiding the pet don't disturb the main lifecycle", async () => {
  const h = await harness(undefined, true);
  press(await h.render(petProps), "session-panel-pet-mode");
  await h.fire("turn.start", { turnId: "main" });
  await h.fire("tool.call", { tool: "AskUserQuestion", agentId: "child" });
  await h.fire("turn.complete", { turnId: "child-turn", agentId: "child", reason: "error" });
  assertScene(await h.render(petProps), "working-typing");
  press(await h.render(petProps), "session-panel-pet-visibility");
  await h.fire("turn.complete", { turnId: "main", reason: "aborted" });
  const hidden = await h.render(petProps);
  assert.ok(!elements(hidden).some(node => node.key === "session-panel-pet-image"));
  assert.ok(text(hidden).includes("Остановлен"));
  press(hidden, "session-panel-pet-visibility");
  const restored = await h.render(petProps);
  assertScene(restored, "shrug");
  assert.ok(text(restored).includes("Коллекция:"), "showing restores the previous random mode");
});

test("scene changes wait for new geometry; callbacks from cancelled timers stay retired", async () => {
  const h = await harness(undefined, true);
  const drawing = await h.render(petProps);
  const timer = h.state.timers.at(-1);
  await h.fire("turn.start", { turnId: "animate" });
  await timer.callback();
  await timer.callback();
  assert.equal(h.state.blits.length, 0, "don't blit a new scene into the previous scene's size");
  await h.render(petProps);
  await timer.callback();
  assert.equal(h.state.blits.length, 1);
  press(drawing, "session-panel-pet-mode");
  await h.render(petProps);
  await timer.callback();
  assert.equal(h.state.blits.length, 1, "old timer must not paint after restart");
  await h.state.timers.at(-1).callback();
  assert.equal(h.state.blits.length, 2);
});

test("the band includes all seven metrics and preserves other mods", async () => {
  const h = await harness();
  const drawn = await h.render();
  assert.equal(drawn.children[0], h.existing);
  for (const reading of [
    "Модель Sonnet 4.6", "Контекст 48 320/200 000 ток · 24.2%",
    "5h 37.5% · сброс 2ч 14м", "7d 62% · сброс 3д 5ч 7м",
    "Сессия $0.1842", "Репо owner/project", "Ветка main",
  ]) assert.ok(text(drawn).includes(reading), reading);
  assert.equal(text(await h.render({}, "desktop")), text(drawn));
});

test("mascot animates by blit without repainting metrics and stops for hidden bands", async () => {
  const h = await harness(undefined, true);
  await h.fire("session.start", { isInteractive: true });
  const props = { bodyColumns: 120, maxRows: 40 };
  const drawing = await h.render(props);
  assert.ok(elements(drawing).some(n => n.key === "session-panel-pet-image"));
  assert.equal(elements(drawing).find(n => n.key === "session-panel-mascot").justifyContent, "flex-end", "mascot stays near the input, at the bottom of the cards");
  assert.equal(elements(drawing).filter(n => n.key?.startsWith("session-panel-card-")).length, 3);
  assert.ok(text(drawing).includes("Репо owner/project"));
  const timer = h.state.timers.find(t => t.ms === 1000 / 12);
  assert.ok(timer);
  const before = h.state.redraws;
  h.state.now += 1000 / 12;
  await timer.callback();
  assert.equal(h.state.blits.length, 1);
  assert.equal(h.state.blits[0].requestId, "test-band");
  assert.equal(h.state.redraws, before);
  press(drawing, "session-panel-pet-mode");
  assert.ok(text(await h.render(props)).includes("Коллекция:"));
  press(await h.render(props), "session-panel-pet-visibility");
  assert.ok(!elements(await h.render(props)).some(n => n.key === "session-panel-pet-image"));
  assert.ok(h.state.cancelled > 0);
  press(await h.render(props), "session-panel-pet-visibility");
  await h.render(props);
  await h.render({ ...props, hasSurvey: true });
  const blits = h.state.blits.length;
  await h.state.timers.at(-1).callback();
  assert.equal(h.state.blits.length, blits, "hidden survey must stop animation");
});

test("narrow and short bands retain metrics while omitting images; denial stops animation", async () => {
  const h = await harness(undefined, true);
  for (const props of [{ bodyColumns: 60, maxRows: 40 }, { bodyColumns: 120, maxRows: 4 }]) {
    const drawing = await h.render(props);
    assert.ok(!elements(drawing).some(n => n.key === "session-panel-pet-image"));
    assert.ok(text(drawing).includes("5h"));
    assert.ok(text(drawing).includes("7d"));
  }
  await h.render({ bodyColumns: 120, maxRows: 40 });
  h.state.blitResult = { deny: "terminal does not support images" };
  const timer = h.state.timers.find(t => t.ms === 1000 / 12);
  await timer.callback();
  assert.equal(h.state.cancelled, 1);
  await timer.callback();
  assert.equal(h.state.blits.length, 1);
});

test("a survey retains exclusive use of the band", async () => {
  const h = await harness();
  assert.equal(await h.render({ hasSurvey: true }), h.existing);
  assert.equal(h.state.processCalls.length, 0);
});

test("readings stay current, Git calls are cached, and external branch changes refresh", async () => {
  let branch = "main";
  const h = await harness(async () => ({ exitCode: 0, stdout: branch, stderr: "" }));
  await h.render();
  h.state.model = "claude-opus-4-6";
  h.state.usage.cost.usd = 1.2345;
  h.state.usage.rateLimits[0].percentUsed = 75;
  const updated = text(await h.render());
  assert.ok(updated.includes("Opus 4.6"));
  assert.ok(updated.includes("$1.2345"));
  assert.ok(updated.includes("5h 75%"));
  assert.equal(h.state.processCalls.length, 1);
  branch = "external-change";
  h.state.now += 15_000;
  assert.ok(text(await h.render()).includes("Ветка external-change"));
  assert.equal(h.state.processCalls.length, 2);
  await h.fire("turn.complete", { agentId: "subagent" });
  await h.render();
  assert.equal(h.state.processCalls.length, 2);
  await h.fire("turn.complete", {});
  await h.render();
  assert.equal(h.state.processCalls.length, 3);
});

test("clear and resume keep the timer but replace context, limits and cost", async () => {
  const h = await harness();
  await h.fire("session.start", { isInteractive: true });
  await h.render();
  await h.fire("session.attach", { surface: "desktop" });
  assert.equal(h.state.timers.length, 1);
  h.state.timers[0].callback();
  assert.equal(h.state.timers[0].ms, 15_000);
  assert.ok(h.state.redraws > 0);
  for (const reason of ["clear", "resume"]) {
    await h.fire("session.end", { reason });
    h.state.usage = { context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } };
    const fresh = text(await h.render());
    assert.ok(fresh.includes("—/1 000 000 ток · —"));
    assert.ok(fresh.includes("5h — · сброс —"));
    assert.ok(fresh.includes("7d — · сброс —"));
    assert.ok(fresh.includes("Сессия $0.0000"));
    assert.equal(h.state.cancelled, 0);
  }
  await h.fire("session.end", { reason: "logout" });
  assert.equal(h.state.cancelled, 1);
});

test("headless sessions start no timer; measurement and commands trigger redraws", async () => {
  const h = await harness();
  await h.fire("session.start", { isInteractive: false, surface: null });
  assert.equal(h.state.timers.length, 0);
  const before = h.state.redraws;
  await h.fire("session.measure", { changed: ["rateLimits"] });
  assert.equal(h.state.redraws, before + 1);
  const commandResult = { text: "model changed" };
  assert.equal(await h.fire("command.run", { command: "model" }, commandResult), commandResult);
  assert.equal(h.state.redraws, before + 2);
});

test("missing Git or unavailable usage still render a usable panel", async () => {
  const h = await harness(async () => { throw new Error("git not found"); });
  h.$.session.usage = async () => { throw new Error("not ready"); };
  const drawn = text(await h.render());
  assert.ok(drawn.includes("Контекст —/— ток · —"));
  assert.ok(drawn.includes("5h — · сброс —"));
  assert.ok(drawn.includes("Репо owner/project"));
  assert.ok(drawn.includes("Ветка —"));
  h.state.repo = null;
  h.state.cwd = "/work/no-git";
  assert.ok(text(await h.render()).includes("Папка no-git"));
});

test("concurrent renders share a Git reading", async () => {
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const h = await harness(async () => { await waiting; return { exitCode: 0, stdout: "main", stderr: "" }; });
  const first = h.render();
  const second = h.render();
  finish();
  await Promise.all([first, second]);
  assert.equal(h.state.processCalls.length, 1);
});

test("narrow bands constrain every metric and keep both limits", async () => {
  const h = await harness();
  for (const width of [1, 20, 40, 80, 160]) {
    const drawn = await h.render({ bodyColumns: width });
    const band = drawn.children[1];
    assert.equal(band.width, width);
    for (const element of elements(band)) if (element.width !== undefined) assert.ok(element.width <= width);
    assert.ok(text(band).includes("5h 37.5%"));
    assert.ok(text(band).includes("7d 62%"));
  }
});

test("expanded cards show remaining quota and exact free tokens", async () => {
  const h = await harness();
  const drawing = await h.render({ bodyColumns: 120, maxRows: 40 });
  const cards = elements(drawing).filter((node) => node.key?.startsWith("session-panel-card-"));
  assert.equal(cards.length, 3);
  for (const reading of ["SESSION PANEL", "24.2% окна", "Свободно 151 680 ток", "37.5% использовано", "Осталось 62.5%", "Осталось 38%", "Сброс через 2ч 14м"]) {
    assert.ok(text(drawing).includes(reading), reading);
  }
  assert.ok(h.state.usageCalls.every((call) => call === undefined));
});

test("toggle remains collapsed across redraws and clear; opening restores cards", async () => {
  const h = await harness();
  const props = { bodyColumns: 120, maxRows: 40 };
  press(await h.render(props), "session-panel-toggle");
  let drawing = await h.render(props);
  assert.equal(elements(drawing).filter((node) => node.key?.startsWith("session-panel-card-")).length, 0);
  await h.fire("session.end", { reason: "clear" });
  drawing = await h.render(props);
  assert.ok(text(drawing).includes("Развернуть"));
  press(drawing, "session-panel-toggle");
  assert.ok(text(await h.render(props)).includes("SESSION PANEL"));
});

test("compact gauges track each reading, retain unknown values, and fit short bands", async () => {
  const h = await harness(undefined, true);
  const props = { bodyColumns: 160, maxRows: 40 };
  press(await h.render(props), "session-panel-toggle");
  const drawing = await h.render(props);
  const band = elements(drawing).find(n => n.key === "session-panel");
  assert.equal(band.minHeight, 6);
  for (const [index,value] of [24.2,37.5,62].entries()) {
    const gauge = elements(drawing).find(n => n.key === `session-panel-compact-meter-${index}`);
    const rendered = text(gauge);
    assert.equal(Array.from(rendered).length,gauge.width);
    assert.equal(rendered.split("█").length-1,Math.round(value/100*gauge.width));
  }
  assert.ok(text(drawing).includes("Ветка main"));
  h.state.usage.context = { window: 200_000 };
  h.state.usage.rateLimits[0].percentUsed = 0;
  const fresh = await h.render(props);
  assert.match(text(elements(fresh).find(n => n.key === "session-panel-compact-meter-0")),/^·+$/);
  assert.match(text(elements(fresh).find(n => n.key === "session-panel-compact-meter-1")),/^░+$/);
  const short = await h.render({ ...props,maxRows:4 });
  assert.ok(!elements(short).some(n => n.key === "session-panel-compact-meters"));
  assert.ok(text(short).includes("5h 0%"));
  assert.ok(text(short).includes("7d 62%"));
});

test("context details request only free summary counts and clear on session changes", async () => {
  const h = await harness();
  h.state.breakdown = {
    rawMaxTokens: 200_000,
    categories: [{ name: "Messages", tokens: 45_120, kind: "used" }, { name: "Free space", tokens: 151_680, kind: "free" }],
    autoCompactThreshold: 180_000,
  };
  const props = { bodyColumns: 120, maxRows: 40 };
  press(await h.render(props), "session-panel-detail-context");
  const opened = await h.render(props);
  assert.ok(text(opened).includes("Messages 45 120 ток"));
  assert.ok(text(opened).includes("Автосжатие от 180 000 ток"));
  assert.ok(h.state.usageCalls.some((call) => call?.breakdown === "summary"));
  press(opened, "session-panel-close-detail");
  assert.ok(!text(await h.render(props)).includes("ПОДРОБНОСТИ КОНТЕКСТА"));
  press(await h.render(props), "session-panel-detail-context");
  await h.fire("session.end", { reason: "resume" });
  assert.ok(!text(await h.render(props)).includes("ПОДРОБНОСТИ КОНТЕКСТА"));
});

test("quota details show an absolute reset date without making a breakdown request", async () => {
  const h = await harness();
  const props = { bodyColumns: 120, maxRows: 40 };
  press(await h.render(props), "session-panel-detail-five_hour");
  const opened = await h.render(props);
  assert.ok(text(opened).includes("Использовано 37.5% · осталось 62.5%"));
  assert.ok(text(opened).includes("Сброс: 5 окт. 2026"));
  assert.ok(h.state.usageCalls.every((call) => call === undefined));
});

test("cards stack on narrow windows and automatic mode respects short windows", async () => {
  const h = await harness();
  for (const width of [40, 80, 120]) {
    const drawing = await h.render({ bodyColumns: width, maxRows: 60 });
    const cards = elements(drawing).filter((node) => node.key?.startsWith("session-panel-card-"));
    assert.equal(cards.length, 3);
    assert.ok(cards.every((card) => card.width <= width - 4));
  }
  const short = await h.render({ bodyColumns: 120, maxRows: 4 });
  assert.ok(text(short).includes("Развернуть"));
  assert.ok(!text(short).includes("SESSION PANEL"));
  press(short, "session-panel-toggle");
  assert.ok(text(await h.render({ bodyColumns: 120, maxRows: 4 })).includes("SESSION PANEL"));
});

test("real Git resolves an unborn branch, a worktree branch and detached HEAD", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "session-panel-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => execute("git", args, { cwd: root });
  await git("init", "-b", "main");
  const run = async (argv, options) => {
    try {
      const result = await execute(argv[0], argv.slice(1), { cwd: options.cwd, timeout: options.timeoutMs });
      return { ...result, exitCode: 0 };
    } catch (error) {
      return { exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const h = await harness(run);
  h.state.cwd = root;
  h.state.repo = { root, remote: null };
  assert.ok(text(await h.render()).includes("Ветка main"));
  await git("-c", "user.name=Panel Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const worktree = join(root, "feature-tree");
  await git("worktree", "add", "-b", "feature/panel", worktree);
  h.state.cwd = worktree;
  assert.ok(text(await h.render()).includes("Ветка feature/panel"));
  assert.equal(h.state.processCalls.at(-1).options.cwd, worktree);
  await execute("git", ["checkout", "--detach", "HEAD"], { cwd: worktree });
  await h.fire("command.run", { command: "status" });
  assert.match(text(await h.render()), /Ветка detached@[a-f0-9]+/);
});
