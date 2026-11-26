import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SettledFiles, isFlowDownload, newDownloads, originIsFlow, sameDownloadName, snapshotDownloads } from "../dist/downloads.js";

const FROM_FLOW = "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://flow.google.com/project/abc\r\nHostUrl=https://flow.google.com/media/xyz\r\n";
const FROM_ELSEWHERE = "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/\r\nHostUrl=https://example.com/report.pdf\r\n";

function folders() {
  const root = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow-test-"));
  const own = join(root, "own");
  const shared = join(root, "shared");
  mkdirSync(own);
  mkdirSync(shared);
  return { root, own, shared };
}

test("a download's recorded origin counts as Flow only for Flow's own addresses", () => {
  assert.equal(originIsFlow(FROM_FLOW), true);
  assert.equal(originIsFlow(FROM_ELSEWHERE), false);
  assert.equal(originIsFlow("[ZoneTransfer]\r\nZoneId=3\r\n"), false);
  // The file came from a storage host, but Flow's page asked for it.
  assert.equal(originIsFlow("ReferrerUrl=https://flow.google.com/\r\nHostUrl=https://storage.googleapis.com/x.mp4\r\n"), true);
  // An address that merely mentions Flow is not Flow.
  assert.equal(originIsFlow("HostUrl=https://example.com/?next=https://flow.google.com/\r\n"), false);
});

test("Chrome's numbered copies match the name it announced, other names do not", () => {
  assert.equal(sameDownloadName("clip.mp4", "clip.mp4"), true);
  assert.equal(sameDownloadName("clip (1).mp4", "clip.mp4"), true);
  assert.equal(sameDownloadName("clip (12).mp4", "clip.mp4"), true);
  assert.equal(sameDownloadName("clip-final.mp4", "clip.mp4"), false);
  assert.equal(sameDownloadName("clip (1).mov", "clip.mp4"), false);
  assert.equal(sameDownloadName("download (2)", "download"), true);
  assert.equal(sameDownloadName("anything.mp4", ""), false);
});

test("a file in the shared folder is taken only with proof it came from Flow", () => {
  const watch = { seen: new Set(), since: 1_000_000 };
  // Recorded origin decides when there is one, whatever the name.
  assert.equal(isFlowDownload({ name: "x.jpeg", born: 1_000_500, origin: FROM_FLOW }, watch, []), true);
  assert.equal(isFlowDownload({ name: "report.pdf", born: 1_000_500, origin: FROM_ELSEWHERE }, watch, ["report.pdf"]), false);
  // No record: only a name Chrome announced on Flow's page.
  assert.equal(isFlowDownload({ name: "holiday.mp4", born: 1_000_500 }, watch, []), false);
  assert.equal(isFlowDownload({ name: "scene (1).mp4", born: 1_000_500 }, watch, ["scene.mp4"]), true);
  // Made before the watch began: not this download, even if it is Flow's.
  assert.equal(isFlowDownload({ name: "x.jpeg", born: 900_000, origin: FROM_FLOW }, watch, ["x.jpeg"]), false);
});

test("anything new in our own folder is ours; an unrelated new file in the shared folder is left alone", () => {
  const { root, own, shared } = folders();
  try {
    writeFileSync(join(own, "old-download"), "old");
    writeFileSync(join(shared, "already-there.pdf"), "old");
    const watch = snapshotDownloads([own, shared]);
    writeFileSync(join(own, "3f2a9c"), "new clip");
    writeFileSync(join(own, "half.crdownload"), "partial");
    writeFileSync(join(shared, "bank-statement.pdf"), "the user's own download");
    assert.deepEqual(newDownloads(watch, own, shared, []), [join(own, "3f2a9c")]);
    // The same shared file is taken once Chrome has announced a download of that name on Flow's page. (Where the
    // system records an origin, a file with no record still needs the announced name.)
    assert.deepEqual(newDownloads(watch, own, shared, ["bank-statement.pdf"]), [join(own, "3f2a9c"), join(shared, "bank-statement.pdf")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file counts as arrived once its size holds still, with several arriving at once", () => {
  const settled = new SettledFiles();
  assert.equal(settled.next([{ path: "a", size: 10 }, { path: "b", size: 5 }]), undefined);
  // "a" is still growing, "b" has stopped: the old single-file check never finished in this case.
  assert.equal(settled.next([{ path: "a", size: 20 }, { path: "b", size: 5 }]), "b");
  assert.equal(settled.next([{ path: "a", size: 20 }]), "a");
  // An empty file is never finished, however long it stays empty.
  const empty = new SettledFiles();
  empty.next([{ path: "e", size: 0 }]);
  assert.equal(empty.next([{ path: "e", size: 0 }]), undefined);
});
