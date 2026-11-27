import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { verifyFileSha256 } from "../dist/captions.js";

test("verifyFileSha256 streams a file and distinguishes matching from mismatched digests", async () => {
  const root = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow-sha256-test-"));
  try {
    const file = join(root, "model.bin");
    const payload = Buffer.from("whisper model test bytes\n");
    writeFileSync(file, payload);
    const expected = createHash("sha256").update(payload).digest("hex");

    assert.equal(await verifyFileSha256(file, expected), true);
    assert.equal(await verifyFileSha256(file, expected.toUpperCase()), true);
    assert.equal(await verifyFileSha256(file, "0".repeat(64)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
