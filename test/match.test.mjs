import assert from "node:assert/strict";
import { test } from "node:test";

import { matchScenes, matchSent } from "../dist/match.js";

test("matchSent matches out-of-order tiles, same prompt with distinct reference ids, and multi-take variants", () => {
  const a = "red apple on marble aaaaaaaa-1111-2222-3333-444444444444";
  const b = "red apple on marble bbbbbbbb-1111-2222-3333-444444444444";
  const c = "green pear on marble";
  assert.deepEqual(matchSent([a, b, c], [c, b, a, c], [1, 1, 2]), [[2], [1], [0, 3]]);
});

test("matchSent ignores unreadable empty tile keys and falls back to prompt words when a reference id is missing", () => {
  const a = "red apple on marble aaaaaaaa-1111-2222-3333-444444444444";
  const c = "green pear on marble";
  assert.deepEqual(matchSent([a, c], ["", c], [1, 1]), [[], [1]]);
  // Reference id absent at send time, present at read-back.
  assert.deepEqual(matchSent(["green pear on marble"], ["green pear on marble cccccccc-1111-2222-3333-444444444444"], [1]), [[0]]);
  // Reference id present at send time, absent at read-back.
  assert.deepEqual(matchSent([a], ["red apple on marble"], [1]), [[0]]);
});

test("matchScenes ignores shared boilerplate and matches distinctive scene words", () => {
  const style = "cinematic golden hour lighting 35mm Kodak film grain shallow depth of field";
  const scenes = [
    `Sailboat entering rocky harbour ${style}`,
    `Baker kneading sourdough dough in wooden kitchen ${style}`,
    `Cyclist climbing misty mountain pass ${style}`,
  ];
  const prompts = [
    `Cyclist riding up a foggy mountain pass ${style}`,
    `Small sailboat gliding into a rocky harbour ${style}`,
    `Baker shaping sourdough bread on a wooden counter ${style}`,
  ];
  assert.deepEqual(matchScenes(scenes, prompts), [[1], [2], [0]]);
});
