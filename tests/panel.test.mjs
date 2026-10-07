import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
    const answer = await hooks.get(name)($, event, next);
    assert.equal(forwarded, 1, "the downstream hook must run exactly once");
    return answer;
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
