import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateRawSync, inflateSync } from "node:zlib";
import { activityLabel, choosePet, completionActivity, createPetState, petFrame, petSize, pets, resultActivity, setActivity, setPetMode, toolActivity } from "../hooks/pets.mjs";

test("all upstream gallery entries have offline PNG frames and valid display sizes", () => {
  const catalog = JSON.parse(readFileSync(new URL("../assets/clawd-pets/catalog.json", import.meta.url)));
  assert.equal(pets.length, 148);
  assert.deepEqual(pets.map(pet => pet.id), catalog.pets.map(pet => pet.id));
  for (const pet of pets) {
    assert.equal(pet.frames.length, Math.ceil(pet.loopMs / 1000 * 12), pet.id);
    assert.ok(pet.width * 2 >= 100 && pet.height * 2 >= 100, `high-resolution artwork: ${pet.id}`);
    for (const frame of pet.frames) {
      const bytes = Buffer.from(frame, "base64");
      assert.equal(inflateRawSync(bytes).length, pet.width * pet.height, pet.id);
    }
    const bytes = Buffer.from(petFrame(pet,0).png,"base64");
    assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16),pet.width*2);
    assert.equal(bytes.readUInt32BE(20),pet.height*2);
    assert.deepEqual(petFrame(pet, 0), petFrame(pet, pet.loopMs));
    const size = petSize(pet);
    assert.ok(size.columns >= 1 && size.columns <= 22);
    assert.ok(size.rows >= 1 && size.rows <= 6);
  }
  assert.ok(pets.filter(p => new Set(p.frames).size > 1).length >= 140, "baked assets must actually animate");
});

test("delta seeking reconstructs the same pixels after backward jumps and scene switches", () => {
  const pet = pets.find(p => p.id === "detective");
  const readPixels = (source) => {
    const bytes = Buffer.from(source.png,"base64");
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii",offset+4,offset+8) === "IDAT") return inflateSync(bytes.subarray(offset+8,offset+8+length));
      offset += length+12;
    }
    throw new Error("missing PNG pixels");
  };
  const expected = petFrame(pet, pet.loopMs * 0.7);
  petFrame(pet,0);
  petFrame(pets[0],300);
  assert.deepEqual(readPixels(petFrame(pet, pet.loopMs * 0.7)),readPixels(expected));
  assert.deepEqual(petFrame(pet,0),petFrame(pet,pet.loopMs));
});

test("random collection visits every scene once per round with no boundary repeat", () => {
  const state = createPetState();
  setPetMode(state, "collection");
  const rounds = [];
  for (let i = 0; i < pets.length * 2; i++) {
    rounds.push(choosePet(state, i * 12_000, () => 0.37).id);
  }
  for (let round = 0; round < 2; round++) assert.equal(new Set(rounds.slice(round * pets.length, (round + 1) * pets.length)).size, pets.length);
  assert.notEqual(rounds[pets.length - 1], rounds[pets.length]);
});

test("work stays pinned in both modes without resetting frames or consuming idle scenes", () => {
  for (const mode of ["auto", "collection"]) {
    const state = createPetState();
    setPetMode(state, mode);
    choosePet(state, 0, () => 0);
    const bag = [...state.bag];
    state.working = true;
    for (const [index, activity] of ["working", "reading", "editing", "searching", "testing", "running", "working-pushing", "shipping", "error", "429", "denied"].entries()) {
      setActivity(state, activity, 1 + index * 120_000);
      assert.equal(choosePet(state, 1 + index * 120_000, () => 0).id, "working-typing");
      assert.equal(state.since, 1, "tool changes must not restart the animation");
      assert.deepEqual(state.bag, bag, "work must not consume the shuffled collection");
    }
    setActivity(state, "waiting", 1_500_000);
    assert.equal(choosePet(state, 1_500_000).id, "working-oncall");
    assert.equal(choosePet(state, 1_620_000).id, "working-oncall");
    setActivity(state, "working", 1_700_000);
    assert.equal(choosePet(state, 1_700_000).id, "working-typing");
  }
});

test("idle auto rotation avoids duplicates; outcomes expire in both modes even while hidden", () => {
  for (const mode of ["auto", "collection", "off"]) {
    const state = createPetState();
    setPetMode(state, mode);
    for (const [activity, id] of Object.entries({ success: "celebrating", error: "error", aborted: "shrug", refusal: "skeptical" })) {
      setActivity(state, activity, 0);
      assert.equal(choosePet(state, 0, () => 0)?.id ?? null, mode === "off" ? null : id);
      assert.equal(choosePet(state, 7_999, () => 0)?.id ?? null, mode === "off" ? null : id);
      choosePet(state, 8_000, () => 0);
      assert.equal(state.activity, "idle");
    }
  }
  const state = createPetState();
  const first = choosePet(state, 0, () => 0).id;
  assert.notEqual(choosePet(state, 12_000, () => 0).id, first);
});

test("tool classification and every completion reason have distinct meanings", () => {
  assert.equal(toolActivity({ tool: "Bash", command: "npm test" }), "testing");
  assert.equal(toolActivity({ tool: "Read" }), "reading");
  assert.equal(toolActivity({ tool: "Bash", command: "git push" }), "working-pushing");
  assert.equal(toolActivity({ tool: "Bash", command: "git push origin feature/test" }), "working-pushing");
  for (const [reason, activity] of Object.entries({ answer: "success", aborted: "aborted", refusal: "refusal", error: "error", unknown: "idle" })) {
    assert.equal(completionActivity({ reason }), activity);
  }
  assert.equal(completionActivity({ reason: "answer", isAborted: true }), "aborted");
  assert.equal(activityLabel({ working: true, activity: "429" }), "Работает · инструмент: HTTP 429");
  assert.equal(activityLabel({ working: false, activity: "error" }), "Ошибка ответа");
});

test("HTTP costumes require an actual HTTP status, not a number in arbitrary output", () => {
  assert.equal(resultActivity({ result: { stdout: "HTTP/2 429\nretry later" } }), "429");
  assert.equal(resultActivity({ result: { stderr: "HTTP status: 404" }, isError: true }), "404");
  assert.equal(resultActivity({ result: "Processed 404 files in 500 ms" }), null);
  assert.equal(resultActivity({ isError: true, result: "build failed" }), "error");
  assert.equal(resultActivity({ text: "HTTP/1.1 503 Service Unavailable", result: {} }), "503");
  assert.equal(resultActivity({ result: { content: [{ type: "text", text: "HTTP status: 401" }] } }), "401");
  assert.equal(resultActivity({ result: { stdout: "HTTP/2 200", exitCode: 1 } }), "error");
  assert.equal(resultActivity({ deny: "blocked" }), "denied");
  assert.equal(resultActivity({ result: { exitCode: 0, stderr: "warning only" } }), null);
  assert.equal(resultActivity({ text: "HTTP/2 301\nHTTP/2 409" }), "409");
  assert.equal(resultActivity({ result: { content: [null, { type: "text", text: "HTTP/2 504" }] } }), "504");
});
