// SPDX-License-Identifier: MIT
// Artwork is vendored from Clawd Pets; see assets/clawd-pets/LICENSE.
import { pets } from "../assets/clawd-pets/frames.mjs";
import { decodePetFrame } from "./pet-codec.mjs";

export { pets };
const byId = new Map(pets.map((pet) => [pet.id, pet]));
const SWAP_MS = 12_000;
const OUTCOME_MS = 8_000;
const outcomes = { success: "celebrating", error: "error", aborted: "shrug", refusal: "skeptical" };
const idlePool = pets.filter((pet) => ["activities", "seasonal"].includes(pet.category) && !["error", "fire", "disconnected", "battery-low"].includes(pet.id)).map((pet) => pet.id);

export function createPetState() {
  return { mode: "auto", visibleMode: "auto", activity: "idle", current: "waving", since: null, changed: null, bag: [], working: false, lastToolResult: null };
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
  if (state.activity !== activity) {
    state.activity = activity;
    state.changed = null;
  }
  state.activityAt = now;
}

export function setPetMode(state, mode) {
  const previous = state.mode === "off" ? state.visibleMode : state.mode;
  if (mode !== "off") {
    state.visibleMode = mode;
    if (previous !== mode) state.bag = [];
  }
  state.mode = mode;
  state.changed = null;
}

export function choosePet(state, now, random = Math.random) {
  // Work and its outcome override BOTH random modes. Tool changes must not
  // restart the typing loop or consume the idle collection's shuffle bag.
  if (!state.working && state.activity !== "idle" && now - state.activityAt >= OUTCOME_MS) {
    setActivity(state, "idle", now);
  }
  if (state.mode === "off") return null;
  const pinned = state.working
    ? (state.activity === "waiting" ? "working-oncall" : "working-typing")
    : outcomes[state.activity] ?? (/^[1-5]\d\d$/.test(state.activity) && byId.has(state.activity) ? state.activity : null);
  if (pinned) {
    if (state.current !== pinned || state.since === null) state.since = now;
    state.current = pinned;
    state.changed = now;
    return byId.get(pinned);
  }
  if (state.changed === null || now - state.changed >= SWAP_MS || now < state.changed) {
    if (state.mode === "collection") {
      if (!state.bag.length) {
        state.bag = shuffle(pets.map((pet) => pet.id), random);
        if (state.bag.at(-1) === state.current) [state.bag[0], state.bag[state.bag.length - 1]] = [state.bag.at(-1), state.bag[0]];
      }
      state.current = state.bag.pop();
    } else {
      const pool = idlePool;
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
  return decodePetFrame(pet, Math.floor(phase / pet.loopMs * pet.frames.length));
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
    if (/\bgit\s+push\b/.test(command)) return "working-pushing";
    if (/\bgit\s+commit\b/.test(command)) return "shipping";
    if (/\b(test|pytest|jest|vitest|cargo test)\b/.test(command)) return "testing";
    return "running";
  }
  return "working";
}

export function resultActivity(result) {
  // Only explicitly labelled HTTP statuses count, never arbitrary numbers.
  const body = result?.result;
  const output = [result?.text, typeof body === "string" ? body : null,
    body?.stdout, body?.stderr, ...(Array.isArray(body?.content) ? body.content.filter(item => item?.type === "text").map(item => item.text) : [])].filter(value => typeof value === "string").join("\n");
  const status = [...output.matchAll(/\b(?:HTTP\/\d(?:\.\d)?\s+|HTTP(?:\s+status)?\s*[:=]?\s+)([1-5]\d\d)\b/gi)].at(-1)?.[1];
  if (result?.deny) return "denied";
  if (status && Number(status) >= 400) return status;
  if (result?.isError || (typeof body?.exitCode === "number" && body.exitCode !== 0)) return "error";
  return status ?? null;
}

export function completionActivity(event) {
  if (event.isAborted || event.reason === "aborted") return "aborted";
  if (event.reason === "answer") return "success";
  if (event.reason === "refusal") return "refusal";
  if (event.reason === "error") return "error";
  return "idle";
}

export function activityLabel(state) {
  if (state.working) {
    if (/^[1-5]\d\d$/.test(state.activity)) return `Работает · инструмент: HTTP ${state.activity}`;
    const actions = { reading: "читает", editing: "редактирует", searching: "ищет", running: "выполняет команду", testing: "тестирует", "working-pushing": "git push", shipping: "git commit", error: "ошибка инструмента", denied: "инструмент не разрешён" };
    if (state.activity === "waiting") return "Ожидает ответа";
    return actions[state.activity] ? `Работает · ${actions[state.activity]}` : "Работает";
  }
  return { success: "Ответ завершён", error: "Ошибка ответа", aborted: "Остановлен", refusal: "Отказ модели" }[state.activity] ?? "Ожидает запроса";
}
