// SPDX-License-Identifier: MIT
// All host operations stay in this module, with literal $.namespace.method calls
// and top-level helpers, as required by Claude Code's static mod analysis.
import { printable } from "./format.mjs";
import { drawPanel, panelLayout } from "./panel.mjs";

const REFRESH_MS = 15_000;
const GIT_OPTIONS = { timeoutMs: 1000, env: { GIT_OPTIONAL_LOCKS: "0" } };
let timer;
let generation = 0;
let panelMode = "auto";
let selectedDetail = null;
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
    selectedDetail = null;
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
    const contextDetails = selectedDetail === "context"
      ? await $.session.usage({ breakdown: "summary" }).catch(() => null)
      : null;
    const { Box, Text, Button } = $.ui.resolve(e);
    const measured = e.props.bodyColumns ?? e.viewport?.columns ?? 80;
    const columns = Number.isFinite(measured) ? Math.max(1, Math.floor(measured)) : 80;
    const layout = panelLayout(columns, e.props.maxRows, panelMode);
    const actions = {
      toggle: () => {
        panelMode = layout.expanded ? "compact" : "expanded";
        selectedDetail = null;
        $.ui.invalidate("ui.render");
      },
      select: (id) => {
        selectedDetail = selectedDetail === id ? null : id;
        $.ui.invalidate("ui.render");
      },
      close: () => {
        selectedDetail = null;
        $.ui.invalidate("ui.render");
      },
    };
    return Box({
      flexDirection: "column",
      children: [existing, drawPanel({ Box, Text, Button }, { model, usage, git, cwd, now, contextDetails }, layout, selectedDetail, actions)],
    });
  });
}
