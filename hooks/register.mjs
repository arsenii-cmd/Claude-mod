// SPDX-License-Identifier: MIT
// All host operations stay in this module, with literal $.namespace.method calls
// and top-level helpers, as required by Claude Code's static mod analysis.
import { metricsFor, printable } from "./format.mjs";

const REFRESH_MS = 15_000;
const GIT_OPTIONS = { timeoutMs: 1000, env: { GIT_OPTIONAL_LOCKS: "0" } };
let timer;
let generation = 0;
const repositories = new Map();
const pendingRepositories = new Map();

function invalidateRepositories() {
  generation += 1;
  repositories.clear();
  pendingRepositories.clear();
}

function startTimer($) {
  if (!timer) {
    timer = $.clock.every(REFRESH_MS, () => {
      $.ui.invalidate("ui.render");
    });
  }
}

async function queryRepository($, cwd) {
  const repo = await $.session.repo().catch(() => null);
  if (!repo) return { repo: null, branch: null };
  try {
    // Use cwd, not repo.root: repo.root can name the main tree of a worktree.
    const branch = await $.process.run(
      ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
      { ...GIT_OPTIONS, cwd },
    );
    if (branch.exitCode === 0 && printable(branch.stdout)) {
      return { repo, branch: printable(branch.stdout) };
    }
    const head = await $.process.run(
      ["git", "rev-parse", "--short", "HEAD"],
      { ...GIT_OPTIONS, cwd },
    );
    return {
      repo,
      branch: head.exitCode === 0 && printable(head.stdout)
        ? `detached@${printable(head.stdout)}`
        : null,
    };
  } catch {
    return { repo, branch: null };
  }
}

async function readRepository($, cwd, now) {
  if (!cwd) return { repo: null, branch: null };
  const cached = repositories.get(cwd);
  if (cached && now >= cached.at && now - cached.at < REFRESH_MS) return cached.value;
  const pending = pendingRepositories.get(cwd);
  if (pending) return pending;
  const ownGeneration = generation;
  const reading = queryRepository($, cwd);
  pendingRepositories.set(cwd, reading);
  try {
    const value = await reading;
    if (ownGeneration === generation) repositories.set(cwd, { at: now, value });
    return value;
  } finally {
    if (pendingRepositories.get(cwd) === reading) pendingRepositories.delete(cwd);
  }
}

function drawBand(Box, Text, rows, columns) {
  const padding = columns >= 6 ? 1 : 0;
  const width = Math.max(1, columns - padding * 2);
  return Box({
    flexDirection: "column",
    width: columns,
    paddingX: padding,
    children: rows.map((metrics) => Box({
      flexDirection: "row",
      flexWrap: "wrap",
      columnGap: 2,
      rowGap: 0,
      children: metrics.map(({ label, value, color }) => Box({
        // Constrain long model/repository/branch names to the band's width.
        width: Math.min(width, Array.from(`${label} ${value}`).length),
        flexShrink: 0,
        children: Text({
          wrap: "wrap",
          children: [
            Text({ dimColor: true, children: `${label} ` }),
            Text({ color, children: value }),
          ],
        }),
      })),
    })),
  });
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    invalidateRepositories();
    if (e.isInteractive || e.surface) startTimer($);
    $.ui.invalidate("ui.render");
    return next(e);
  });

  on("session.attach", async ($, e, next) => {
    startTimer($);
    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    $.ui.invalidate("ui.render");
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      invalidateRepositories();
      $.ui.invalidate("ui.render");
    }
    return result;
  });

  on("command.run", async ($, e, next) => {
    const result = await next(e);
    invalidateRepositories();
    $.ui.invalidate("ui.render");
    return result;
  });

  on("session.end", async ($, e, next) => {
    invalidateRepositories();
    // /clear, /resume and /branch don't run session.start again.
    if (e.reason !== "clear" && e.reason !== "resume") {
      timer?.cancel();
      timer = undefined;
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const existing = await next(e);
    const [model, usage, cwd, now] = await Promise.all([
      $.session.model().catch(() => null),
      $.session.usage().catch(() => null),
      $.session.cwd().catch(() => null),
      $.clock.now(),
    ]);
    const git = await readRepository($, cwd, now);
    const { Box, Text } = $.ui.resolve(e);
    const measured = e.props.bodyColumns ?? e.viewport?.columns ?? 80;
    const columns = Number.isFinite(measured) ? Math.max(1, Math.floor(measured)) : 80;
    return Box({
      flexDirection: "column",
      children: [existing, drawBand(Box, Text, metricsFor(model, usage, git, cwd, now), columns)],
    });
  });
}
