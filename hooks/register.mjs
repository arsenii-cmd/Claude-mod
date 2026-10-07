// SPDX-License-Identifier: MIT
// All host operations stay in this module, with literal $.namespace.method calls
// and top-level helpers, as required by Claude Code's static mod analysis.
import { printable } from "./format.mjs";
import { drawPanel, panelLayout } from "./panel.mjs";
import { activityLabel, choosePet, completionActivity, createPetState, petFrame, petSize, pets, resultActivity, setActivity, setPetMode, toolActivity } from "./pets.mjs";

const REFRESH_MS = 15_000;
const GIT_OPTIONS = { timeoutMs: 1000, env: { GIT_OPTIONAL_LOCKS: "0" } };
let timer;
let generation = 0;
let panelMode = "auto";
let selectedDetail = null;
const petState = createPetState();
let animationTimer;
let imageSite;
let blitting = false;
let animationGeneration = 0;
let turnEpoch = 0;
let activeTurnId = null;
let hostWasWorking;
let settled = false;
const pendingTools = new Map();
const retiredTurns = new Set();

function resetTurn(working, turnId = null) {
  if (activeTurnId && activeTurnId !== turnId) {
    retiredTurns.add(activeTurnId);
    if (retiredTurns.size > 32) retiredTurns.delete(retiredTurns.values().next().value);
  }
  turnEpoch += 1;
  activeTurnId = turnId;
  pendingTools.clear();
  petState.working = working;
  petState.lastToolResult = null;
  settled = !working;
}

function pendingActivity() {
  const tools = [...pendingTools.values()];
  if (tools.some(tool => tool.waiting)) return "waiting";
  return tools.at(-1)?.activity ?? petState.lastToolResult ?? "working";
}

function syncWorking(isWorking, now) {
  if (typeof isWorking !== "boolean") return;
  // A just-completed turn can still have isWorking=true for one render.
  if (isWorking && !petState.working && (!settled || hostWasWorking === false)) {
    resetTurn(true);
    setActivity(petState, "working", now);
  } else if (!isWorking && petState.working && hostWasWorking === true) {
    resetTurn(false, activeTurnId);
    setActivity(petState, "idle", now);
  }
  hostWasWorking = isWorking;
}

function stopAnimation() {
  animationGeneration += 1;
  animationTimer?.cancel();
  animationTimer = undefined;
  imageSite = undefined;
}

function startAnimation($) {
  if (animationTimer || !imageSite) return;
  const ownGeneration = animationGeneration;
  animationTimer = $.clock.every(1000 / 12, async () => {
    if (!imageSite || blitting || ownGeneration !== animationGeneration) return;
    blitting = true;
    const mounted = imageSite;
    try {
      const now = await $.clock.now();
      if (ownGeneration !== animationGeneration || imageSite !== mounted) return;
      const previousActivity = petState.activity;
      const pet = choosePet(petState, now);
      if (!pet) return;
      if (mounted.petId !== pet.id || previousActivity !== petState.activity) {
        $.ui.invalidate("ui.render");
        return;
      }
      const result = await $.ui.blit({ requestId: mounted.requestId, key: "session-panel-pet-image", source: petFrame(pet, now - petState.since) });
      if (result?.deny && imageSite === mounted) stopAnimation();
    } catch {
      if (imageSite === mounted) stopAnimation();
    } finally {
      blitting = false;
    }
  });
}
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
    resetTurn(false);
    settled = false;
    hostWasWorking = undefined;
    const ownEpoch = turnEpoch;
    const now = await $.clock.now();
    if (ownEpoch === turnEpoch) setActivity(petState, "idle", now);
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
    const ownEpoch = turnEpoch;
    const result = await next(e);
    const now = await $.clock.now();
    if (!e.agentId && ownEpoch === turnEpoch && !retiredTurns.has(e.turnId)
      && (!settled || (activeTurnId && activeTurnId === e.turnId))
      && (!activeTurnId || !e.turnId || e.turnId === activeTurnId)) {
      resetTurn(false);
      hostWasWorking = undefined;
      setActivity(petState, completionActivity(e), now);
      invalidateRepositories();
      $.ui.invalidate("ui.render");
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    if (!e.agentId) {
      resetTurn(true, e.turnId);
      const ownEpoch = turnEpoch;
      const now = await $.clock.now();
      if (ownEpoch === turnEpoch) {
        setActivity(petState, "working", now);
        $.ui.invalidate("ui.render");
      }
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (e.agentId) return next(e);
    if (!petState.working && !settled) resetTurn(true);
    const ownEpoch = turnEpoch;
    const key = e.tool_use_id ?? {};
    const activity = toolActivity(e);
    const token = { activity, waiting: activity === "waiting" };
    pendingTools.set(key, token);
    const started = await $.clock.now();
    if (ownEpoch === turnEpoch && pendingTools.get(key) === token) {
      setActivity(petState, pendingActivity(), started);
      $.ui.invalidate("ui.render");
    }
    try {
      const result = await next(e);
      const now = await $.clock.now();
      if (ownEpoch === turnEpoch && pendingTools.get(key) === token) {
        pendingTools.delete(key);
        petState.lastToolResult = resultActivity(result);
        setActivity(petState, petState.working ? pendingActivity() : "idle", now);
        $.ui.invalidate("ui.render");
      }
      return result;
    } catch (error) {
      const now = await $.clock.now();
      if (ownEpoch === turnEpoch && pendingTools.get(key) === token) {
        pendingTools.delete(key);
        petState.lastToolResult = "error";
        setActivity(petState, petState.working ? pendingActivity() : "idle", now);
        $.ui.invalidate("ui.render");
      }
      throw error;
    }
  });

  on("command.run", async ($, e, next) => {
    const result = await next(e);
    invalidateRepositories();
    $.ui.invalidate("ui.render");
    return result;
  });

  on("session.end", async ($, e, next) => {
    stopAnimation();
    resetTurn(false);
    hostWasWorking = undefined;
    const ownEpoch = turnEpoch;
    const now = await $.clock.now();
    if (ownEpoch === turnEpoch) setActivity(petState, "idle", now);
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
    const ownEpoch = turnEpoch;
    const observedAt = await $.clock.now();
    if (ownEpoch === turnEpoch) syncWorking(e.props.isWorking, observedAt);
    if (e.props.hasSurvey) {
      stopAnimation();
      return next(e);
    }
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
    const { Box, Text, Button, Image } = $.ui.resolve(e);
    const measured = e.props.bodyColumns ?? e.viewport?.columns ?? 80;
    const columns = Number.isFinite(measured) ? Math.max(1, Math.floor(measured)) : 80;
    const pet = choosePet(petState, now);
    const controlsVisible = columns >= 40 && (e.props.maxRows ?? Infinity) >= 6;
    const controlRows = controlsVisible ? (columns >= 120 ? 2 : 3) : 0;
    const showPet = Boolean(pet && Image && e.surface === "terminal" && columns >= 72 && (e.props.maxRows ?? Infinity) >= 9);
    // Reserve mascot space before laying out cards: metrics wrap instead of disappearing.
    const panelColumns = columns - (showPet ? 24 : 0);
    const layout = panelLayout(panelColumns, e.props.maxRows === undefined ? undefined : Math.max(0, e.props.maxRows - controlRows), panelMode);
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
    const changeMode = (mode) => {
      setPetMode(petState, mode);
      stopAnimation();
      $.ui.invalidate("ui.render");
    };
    const panel = drawPanel({ Box, Text, Button }, { model, usage, git, cwd, now, contextDetails }, layout, selectedDetail, actions);
    const controls = controlsVisible ? Box({
      key: "session-panel-pet-controls", flexDirection: "row", flexWrap: "wrap", columnGap: 2,
      children: [
        Button({ key: "session-panel-pet-mode", label: petState.mode === "collection" ? "По действиям" : `Вся коллекция · ${pets.length}`, plain: true, onPress: () => changeMode(petState.mode === "collection" ? "auto" : "collection") }),
        Button({ key: "session-panel-pet-visibility", label: petState.mode === "off" ? "Показать Clawd" : "Скрыть Clawd", plain: true, dimColor: true, onPress: () => changeMode(petState.mode === "off" ? petState.visibleMode : "off") }),
        pet ? Text({ dimColor: true, children: `${petState.mode === "collection" ? "Коллекция" : "Clawd"}: ${pet.name}` }) : null,
        Text({ key: "session-panel-pet-state", dimColor: true, children: activityLabel(petState) }),
      ],
    }) : null;
    const mascot = showPet ? Box({ key: "session-panel-mascot", width: 22, flexShrink: 0, flexDirection: "column", alignItems: "center", justifyContent: "flex-end", children: [
      Image({ key: "session-panel-pet-image", source: petFrame(pet, now - petState.since), ...petSize(pet), alt: `Clawd: ${pet.name}` }),
    ] }) : null;
    if (showPet && e.requestId) {
      imageSite = { requestId: e.requestId, petId: pet.id };
      startAnimation($);
    } else stopAnimation();
    return Box({
      flexDirection: "column",
      children: [existing, Box({ key: "session-panel-with-pet", width: columns, flexDirection: "column", children: [
        Box({ flexDirection: "row", columnGap: showPet ? 2 : 0, children: [panel, mascot] }),
        controls,
      ] })],
    });
  });
}
