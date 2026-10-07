import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateRawSync, inflateSync } from "node:zlib";
import { choosePet, createPetState, petFrame, petSize, pets, resultActivity, setActivity, setPetMode, toolActivity } from "../hooks/pets.mjs";

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
  setActivity(state, "error", pets.length * 24_000);
  assert.equal(state.changed, (pets.length * 2 - 1) * 12_000, "tool events do not interrupt collection");
});

test("auto mode reacts to work, avoids consecutive duplicates, and times out celebrations", () => {
  const state = createPetState();
  state.working = true;
  setActivity(state, "editing", 0);
  const first = choosePet(state, 0, () => 0).id;
  assert.ok(["working-typing", "coding", "working-building", "crafting"].includes(first));
  assert.notEqual(choosePet(state, 12_000, () => 0).id, first);
  assert.equal(toolActivity({ tool: "Bash", command: "npm test" }), "testing");
  assert.equal(toolActivity({ tool: "Read" }), "reading");
  assert.equal(toolActivity({ tool: "Bash", command: "git push" }), "working-pushing");
  state.working = false;
  setActivity(state, "success", 13_000);
  assert.equal(choosePet(state, 13_000, () => 0).id, "celebrating");
  choosePet(state, 21_000, () => 0);
  assert.equal(state.activity, "idle");
  setPetMode(state, "off");
  assert.equal(choosePet(state, 22_000), null);
});

test("HTTP costumes require an actual HTTP status, not a number in arbitrary output", () => {
  assert.equal(resultActivity({ result: { stdout: "HTTP/2 429\nretry later" } }), "429");
  assert.equal(resultActivity({ result: { stderr: "HTTP status: 404" }, isError: true }), "404");
  assert.equal(resultActivity({ result: "Processed 404 files in 500 ms" }), null);
  assert.equal(resultActivity({ isError: true, result: "build failed" }), "error");
});
