import assert from "node:assert/strict";
import { test } from "node:test";

import { borderColour, computeDifferenceMatte } from "../dist/matte.js";

function makePair(width, height, bgW, bgB, paint) {
  const w = new Uint8Array(width * height * 3);
  const b = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      const custom = paint?.(x, y);
      const pw = custom ? custom.w : bgW;
      const pb = custom ? custom.b : bgB;
      w[o] = pw[0];
      w[o + 1] = pw[1];
      w[o + 2] = pw[2];
      b[o] = pb[0];
      b[o + 1] = pb[1];
      b[o + 2] = pb[2];
    }
  }
  return { w, b };
}

test("borderColour reads median RGB from the image border ring", () => {
  const { w } = makePair(20, 20, [253, 252, 250], [2, 3, 4], (x, y) => {
    // Solid bright red centre should not perturb the border median.
    if (x >= 4 && x < 16 && y >= 4 && y < 16) return { w: [220, 10, 10], b: [220, 10, 10] };
    return undefined;
  });
  assert.deepEqual(borderColour(w, 20, 20), [253, 252, 250]);
});

test("computeDifferenceMatte recovers opaque, clear, and 50% translucent pixels accurately", () => {
  const bgW = [253, 253, 253];
  const bgB = [3, 3, 3];
  const solid = [40, 180, 90];
  const semi = [200, 60, 120];
  const composite = (fg, bg, alpha) => [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];

  const { w, b } = makePair(20, 20, bgW, bgB, (x, y) => {
    if (x >= 4 && x < 10 && y >= 4 && y < 16) return { w: solid, b: solid };
    if (x >= 10 && x < 16 && y >= 4 && y < 16) {
      return { w: composite(semi, bgW, 0.5), b: composite(semi, bgB, 0.5) };
    }
    return undefined;
  });

  const out = computeDifferenceMatte(w, b, 20, 20);
  assert.equal(out.background_white, "#fdfdfd");
  assert.equal(out.background_black, "#030303");
  assert.equal(out.mismatch_share, 0);
  assert.equal(out.warning, undefined);

  // Corner background pixel -> fully transparent.
  assert.equal(out.rgba[3], 0);

  // Solid pixel at (5, 5) -> fully opaque with exact RGB.
  const solidIdx = (5 * 20 + 5) * 4;
  assert.deepEqual([...out.rgba.subarray(solidIdx, solidIdx + 4)], [40, 180, 90, 255]);

  // Semi-transparent pixel at (12, 10) -> ~50% alpha and un-premultiplied RGB close to [200, 60, 120].
  const semiIdx = (10 * 20 + 12) * 4;
  assert.ok(Math.abs(out.rgba[semiIdx + 3] - 128) <= 2, `expected alpha near 128, got ${out.rgba[semiIdx + 3]}`);
  assert.ok(Math.abs(out.rgba[semiIdx] - 200) <= 3, `expected R near 200, got ${out.rgba[semiIdx]}`);
  assert.ok(Math.abs(out.rgba[semiIdx + 1] - 60) <= 3, `expected G near 60, got ${out.rgba[semiIdx + 1]}`);
  assert.ok(Math.abs(out.rgba[semiIdx + 2] - 120) <= 3, `expected B near 120, got ${out.rgba[semiIdx + 2]}`);
});

test("computeDifferenceMatte rejects non-white/black or swapped backgrounds", () => {
  const grey = makePair(16, 16, [128, 128, 128], [120, 120, 120]);
  assert.throws(() => computeDifferenceMatte(grey.w, grey.b, 16, 16), /backgrounds did not come out white and black/);

  const swapped = makePair(16, 16, [10, 10, 10], [245, 245, 245]);
  assert.throws(() => computeDifferenceMatte(swapped.w, swapped.b, 16, 16), /backgrounds did not come out white and black/);
});

test("computeDifferenceMatte warns on subject mismatch or empty cutout", () => {
  // Subject brighter on the black take than on the white take -> mismatch warning.
  const changed = makePair(20, 20, [255, 255, 255], [0, 0, 0], (x, y) => {
    if (x >= 5 && x < 15 && y >= 5 && y < 15) return { w: [80, 80, 80], b: [180, 180, 180] };
    return undefined;
  });
  const changedOut = computeDifferenceMatte(changed.w, changed.b, 20, 20);
  assert.ok(changedOut.mismatch_share > 0.5);
  assert.match(changedOut.warning ?? "", /changed the subject/);

  // Background-only pair -> almost-nothing-kept warning.
  const empty = makePair(20, 20, [255, 255, 255], [0, 0, 0]);
  const emptyOut = computeDifferenceMatte(empty.w, empty.b, 20, 20);
  assert.equal(emptyOut.clear_share, 1);
  assert.match(emptyOut.warning ?? "", /Almost nothing was kept/);
});

test("computeDifferenceMatte rejects mismatched buffer dimensions", () => {
  assert.throws(() => computeDifferenceMatte(new Uint8Array(10), new Uint8Array(10), 4, 4), /Expected 48-byte RGB buffers/);
});
