import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { extractFirstFrame, extractFrameAt, extractLastFrame, requireLocalFile } from "../dist/chain.js";
import { validateRingColor } from "../dist/presenter.js";

test("validateRingColor accepts plain colour names and 6-digit hex, and rejects filter injection", () => {
  assert.equal(validateRingColor("white"), "white");
  assert.equal(validateRingColor("dodgerblue"), "dodgerblue");
  assert.equal(validateRingColor("#FFAA00"), "#FFAA00");
  assert.equal(validateRingColor("#00ff88"), "#00ff88");

  assert.throws(() => validateRingColor("white:s=8x8[x];movie=/etc/passwd"), /Invalid ring_color/i);
  assert.throws(() => validateRingColor("white,format=rgba"), /Invalid ring_color/i);
  assert.throws(() => validateRingColor("#fff"), /Invalid ring_color/i);
  assert.throws(() => validateRingColor("red@0.5"), /Invalid ring_color/i);
  assert.throws(() => validateRingColor(""), /Invalid ring_color/i);
});

test("requireLocalFile accepts regular local files and refuses URLs, directories, and missing paths", async () => {
  const root = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow-ffmpeg-inputs-"));
  try {
    const file = join(root, "clip.mp4");
    writeFileSync(file, "not-empty");

    assert.equal(requireLocalFile(file), file);
    assert.throws(() => requireLocalFile("https://example.com/clip.mp4"), /not a URL/i);
    assert.throws(() => requireLocalFile("http://127.0.0.1:8080/clip.mp4"), /not a URL/i);
    assert.throws(() => requireLocalFile("file:///etc/passwd"), /not a URL/i);
    assert.throws(() => requireLocalFile(join(root, "missing.mp4")), /not found/i);
    assert.throws(() => requireLocalFile(root), /not a regular file/i);

    await assert.rejects(() => extractLastFrame("https://example.com/clip.mp4", root), /not a URL/i);
    await assert.rejects(() => extractFirstFrame("http://127.0.0.1/clip.mp4", root), /not a URL/i);
    await assert.rejects(() => extractFrameAt(join(root, "missing.mp4"), 1, root), /not found/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
