// SPDX-License-Identifier: MIT
// Artwork is vendored from Clawd Pets; see assets/clawd-pets/LICENSE.
import { pets } from "../assets/clawd-pets/frames.mjs";

export { pets };
const byId = new Map(pets.map((pet) => [pet.id, pet]));
const SWAP_MS = 12_000;
const pools = {
  working: ["working-typing", "coding", "working-thinking", "working-wizard"],
  reading: ["reading", "studying", "working-reviewing", "detective"],
  editing: ["working-typing", "coding", "working-building", "crafting"],
  running: ["running", "working-tool-calling", "working-carrying"],
  testing: ["working-testing", "working-debugger", "working-rubber-duck"],
  searching: ["detective", "telescope", "working-reviewing"],
  success: ["celebrating", "clapping", "dancing", "happy", "trophy"],
  error: ["working-debugger", "working-confused", "working-rubber-duck"],
  waiting: ["peeking", "working-oncall", "working-thinking"],
  idle: pets.filter((pet) => ["activities", "seasonal"].includes(pet.category) && !["error", "fire", "disconnected", "battery-low"].includes(pet.id)).map((pet) => pet.id),
};

export function createPetState() {
  return { mode: "auto", activity: "idle", current: "waving", since: null, changed: null, bag: [], working: false };
}

function shuffle(ids, random) {
  const bag = [...ids];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

export function setActivity(state, activity, now) {
  // Collection is purely decorative: tool events never interrupt its shuffle.
  if (state.activity !== activity) {
    state.activity = activity;
    if (state.mode === "auto") state.changed = null;
  }
  state.activityAt = now;
}

export function setPetMode(state, mode) {
  state.mode = mode;
  state.changed = null;
  state.bag = [];
}

export function choosePet(state, now, random = Math.random) {
  if (state.mode === "off") return null;
  if (state.mode === "auto" && ["success", "error"].includes(state.activity) && now - state.activityAt >= 8_000) {
    setActivity(state, state.working ? "working" : "idle", now);
  }
  if (state.changed === null || now - state.changed >= SWAP_MS || now < state.changed) {
    if (state.mode === "collection") {
      if (!state.bag.length) {
        state.bag = shuffle(pets.map((pet) => pet.id), random);
        if (state.bag.at(-1) === state.current) [state.bag[0], state.bag[state.bag.length - 1]] = [state.bag.at(-1), state.bag[0]];
      }
      state.current = state.bag.pop();
    } else {
      const pool = (pools[state.activity] ?? (byId.has(state.activity) ? [state.activity] : pools.working));
      const candidates = pool.filter((id) => id !== state.current);
      const choices = candidates.length ? candidates : pool;
      state.current = choices[Math.floor(random() * choices.length)];
    }
    state.changed = now;
    state.since = now;
  }
  return byId.get(state.current);
}

export function petFrame(pet, elapsed) {
  const phase = ((elapsed % pet.loopMs) + pet.loopMs) % pet.loopMs;
  return { png: pet.frames[Math.floor(phase / pet.loopMs * pet.frames.length)] };
}

export function petSize(pet) {
  const ratio = pet.width / pet.height;
  // Terminal cells are approximately twice as tall as they are wide.
  return ratio >= 22 / 12
    ? { columns: 22, rows: Math.max(1, Math.round(22 / ratio / 2)) }
    : { columns: Math.max(1, Math.round(12 * ratio)), rows: 6 };
}

export function toolActivity(event) {
  const tool = String(event.tool ?? "");
  if (/^(Read|NotebookRead)$/.test(tool)) return "reading";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return "editing";
  if (/^(Grep|Glob|WebSearch|WebFetch)$/.test(tool)) return "searching";
  if (tool === "AskUserQuestion") return "waiting";
  if (tool === "Bash") {
    const command = String(event.command ?? event.input?.command ?? "");
    if (/\b(test|pytest|jest|vitest|cargo test)\b/.test(command)) return "testing";
    if (/\bgit\s+push\b/.test(command)) return "working-pushing";
    if (/\bgit\s+commit\b/.test(command)) return "shipping";
    return "running";
  }
  return "working";
}

export function resultActivity(result) {
  // Only explicitly labelled HTTP statuses count, never arbitrary numbers.
  const body = result?.result;
  const output = typeof body === "string" ? body : [body?.stdout, body?.stderr].filter(Boolean).join("\n");
  const status = output.match(/\b(?:HTTP\/\d(?:\.\d)?\s+|HTTP(?:\s+status)?\s*[:=]?\s+)([1-5]\d\d)\b/i)?.[1];
  if (status && byId.has(status)) return status;
  return result?.isError ? "error" : null;
}
