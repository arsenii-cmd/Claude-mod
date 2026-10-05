import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const execute = promisify(execFile);
let moduleId = 0;

async function harness(run) {
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
    processCalls: [], timers: [], cancelled: 0, redraws: 0,
  };
  const element = (type) => (props) => ({ type, ...props });
  const $ = {
    session: {
      model: async () => state.model,
      usage: async (...args) => {
        assert.equal(args.length, 0, "status readings must not request a paid breakdown");
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
      resolve: () => ({ Box: element("Box"), Text: element("Text") }),
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
    props: { hasSurvey: false, bodyColumns: 80, ...props },
  }, existing);
  return { $, state, existing, fire, render };
}

function text(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" ? text(node.children) : "";
}

test("the band includes all seven metrics and preserves other mods", async () => {
  const h = await harness();
  const drawn = await h.render();
  assert.equal(drawn.children[0], h.existing);
  for (const reading of [
    "Модель claude-sonnet-4-6", "Контекст 48 320/200 000 ток · 24.2%",
    "5h 37.5% · сброс 2ч 14м", "7d 62% · сброс 3д 5ч 7м",
    "Сессия $0.1842", "Репо owner/project", "Ветка main",
  ]) assert.ok(text(drawn).includes(reading), reading);
  assert.equal(text(await h.render({}, "desktop")), text(drawn));
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
  assert.ok(updated.includes("claude-opus-4-6"));
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
    for (const row of band.children) {
      assert.equal(row.flexWrap, "wrap");
      for (const metric of row.children) assert.ok(metric.width <= width);
    }
    assert.ok(text(band).includes("5h 37.5%"));
    assert.ok(text(band).includes("7d 62%"));
  }
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
