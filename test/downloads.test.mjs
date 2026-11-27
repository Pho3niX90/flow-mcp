import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FLOW_ORIGINS, FREE_UPSCALE, MUSIC_ORIGINS, SettledFiles, isFlowDownload, kindOfBytes, newDownloads, originIsFlow, originsForSite, sameDownloadName, snapshotDownloads } from "../dist/downloads.js";
import { extensionOf } from "../dist/page-downloads.js";

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
  // Recorded origin alone decides when Chrome did not announce download names.
  assert.equal(isFlowDownload({ name: "x.jpeg", born: 1_000_500, origin: FROM_FLOW }, watch, []), true);
  // When both recorded origin and announced names are present, BOTH must match.
  assert.equal(isFlowDownload({ name: "x.jpeg", born: 1_000_500, origin: FROM_FLOW }, watch, ["x.jpeg"]), true);
  assert.equal(isFlowDownload({ name: "x (1).jpeg", born: 1_000_500, origin: FROM_FLOW }, watch, ["x.jpeg"]), true);
  assert.equal(isFlowDownload({ name: "other.jpeg", born: 1_000_500, origin: FROM_FLOW }, watch, ["x.jpeg"]), false);
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

test("free upscale guard accepts 2K and 1080p and refuses paid 4K", () => {
  assert.equal(FREE_UPSCALE.test("2K Upscaled"), true);
  assert.equal(FREE_UPSCALE.test("1080p Upscaled"), true);
  assert.equal(FREE_UPSCALE.test("2k upscaled"), true);
  assert.equal(FREE_UPSCALE.test("4K Upscaled"), false);
  assert.equal(FREE_UPSCALE.test("4K (50 credits)"), false);
  assert.equal(FREE_UPSCALE.test("720p Original size"), false);
  assert.equal(FREE_UPSCALE.test("1K Original size"), false);
});

test("origin proof separates Flow and Flow Music downloads and rejects look-alike hosts", () => {
  const fromMusicWww = "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://www.flowmusic.app/chat/1\r\nHostUrl=https://storage.googleapis.com/song.mp3\r\n";
  const fromMusicBare = "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://flowmusic.app/download/track.wav\r\n";
  const lookAlike1 = "ReferrerUrl=https://flowmusic.app.evil.example/\r\n";
  const lookAlike2 = "HostUrl=https://notflowmusic.app/song.mp3\r\n";
  const lookAlike3 = "ReferrerUrl=https://flow.google.com.evil.example/\r\n";

  // Flow accepts Flow, rejects Flow Music and look-alikes.
  assert.equal(originIsFlow(FROM_FLOW, FLOW_ORIGINS), true);
  assert.equal(originIsFlow(fromMusicWww, FLOW_ORIGINS), false);
  assert.equal(originIsFlow(fromMusicBare, FLOW_ORIGINS), false);
  assert.equal(originIsFlow(lookAlike3, FLOW_ORIGINS), false);

  // Flow Music accepts Flow Music (www and bare), rejects Flow and look-alikes.
  assert.equal(originIsFlow(fromMusicWww, MUSIC_ORIGINS), true);
  assert.equal(originIsFlow(fromMusicBare, MUSIC_ORIGINS), true);
  assert.equal(originIsFlow(FROM_FLOW, MUSIC_ORIGINS), false);
  assert.equal(originIsFlow(lookAlike1, MUSIC_ORIGINS), false);
  assert.equal(originIsFlow(lookAlike2, MUSIC_ORIGINS), false);

  const watch = { seen: new Set(), since: 1_000_000 };
  assert.equal(isFlowDownload({ name: "song.mp3", born: 1_000_500, origin: fromMusicWww }, watch, [], originsForSite("music")), true);
  assert.equal(isFlowDownload({ name: "song.mp3", born: 1_000_500, origin: fromMusicWww }, watch, ["song.mp3"], originsForSite("flow")), false);
  assert.equal(isFlowDownload({ name: "clip.mp4", born: 1_000_500, origin: FROM_FLOW }, watch, ["clip.mp4"], originsForSite("music")), false);
});

test("kindOfBytes and extensionOf identify images, videos, archives, audio formats, and unknown bytes", () => {
  const bytes = (...vals) => Uint8Array.from(vals);
  const str = (s) => Uint8Array.from(Buffer.from(s, "latin1"));

  // Existing formats unchanged:
  assert.equal(kindOfBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)), ".jpeg");
  assert.equal(kindOfBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), ".png");
  assert.equal(kindOfBytes(str("RIFF\x00\x00\x00\x00WEBP")), ".webp");
  assert.equal(kindOfBytes(str("\x00\x00\x00\x18ftypisom")), ".mp4");
  assert.equal(kindOfBytes(str("\x00\x00\x00\x18ftypmp42")), ".mp4");
  assert.equal(kindOfBytes(str("GIF89a")), ".gif");
  assert.equal(kindOfBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00)), ".zip");
  assert.equal(kindOfBytes(str("not a known header")), ".bin");
  assert.equal(kindOfBytes(new Uint8Array(0)), ".bin");

  // Audio formats:
  assert.equal(kindOfBytes(str("ID3\x03\x00\x00\x00")), ".mp3");
  assert.equal(kindOfBytes(bytes(0xff, 0xfb, 0x90, 0x64)), ".mp3");
  assert.equal(kindOfBytes(bytes(0xff, 0xf3, 0x80, 0x00)), ".mp3");
  assert.equal(kindOfBytes(bytes(0xff, 0xe3, 0x00, 0x00)), ".mp3");
  // JPEG FF D8 must never be misread as MP3, nor FF C0 (top 3 bits not all set).
  assert.equal(kindOfBytes(bytes(0xff, 0xd8, 0xff, 0xdb)), ".jpeg");
  assert.equal(kindOfBytes(bytes(0xff, 0xc0, 0x00, 0x00)), ".bin");
  assert.equal(kindOfBytes(str("RIFF\x24\x00\x00\x00WAVEfmt ")), ".wav");
  assert.equal(kindOfBytes(str("fLaC\x00\x00\x00\x22")), ".flac");
  assert.equal(kindOfBytes(str("OggS\x00\x02\x00\x00")), ".ogg");
  assert.equal(kindOfBytes(str("\x00\x00\x00\x20ftypM4A ")), ".m4a");
  assert.equal(kindOfBytes(str("\x00\x00\x00\x20ftypM4B ")), ".m4a");

  // extensionOf reads from disk and delegates to kindOfBytes.
  const { root, own } = folders();
  try {
    const mp3 = join(own, "bare-id-mp3");
    const wav = join(own, "bare-id-wav");
    writeFileSync(mp3, Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"));
    writeFileSync(wav, Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"));
    assert.equal(extensionOf(mp3), ".mp3");
    assert.equal(extensionOf(wav), ".wav");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
