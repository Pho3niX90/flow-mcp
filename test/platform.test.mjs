import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { moveFile } from "../dist/platform.js";

test("moveFile moves a file and preserves its contents", () => {
  const root = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow-platform-test-"));
  try {
    const src = join(root, "from.bin");
    const dest = join(root, "to.bin");
    writeFileSync(src, "clip-bytes");
    moveFile(src, dest);
    assert.equal(existsSync(src), false);
    assert.equal(readFileSync(dest, "utf8"), "clip-bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
