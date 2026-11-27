import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { characterLook, characterVoice, rememberCharacter, rememberVoice } from "../dist/flow.js";
import { assertAllowedUploadFile } from "../dist/page-downloads.js";
import { ffmpeg, ffprobe, findTool, moveFile, psQuote, systemTool, walkExtractedFiles } from "../dist/platform.js";

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

test("findTool prefers PATH, then WinGet Links or nested Packages/bin, without choking on files", () => {
  const local = "C:\\Users\\test\\AppData\\Local";
  const pkgs = join(local, "Microsoft", "WinGet", "Packages");
  const links = join(local, "Microsoft", "WinGet", "Links");
  const pkgDir = join(pkgs, "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe");
  const buildDir = join(pkgDir, "ffmpeg-7.1-full_build");
  const nestedExe = join(buildDir, "bin", "ffmpeg.exe");
  const strayFile = join(pkgs, "ffmpeg-notes.txt");
  const strayLink = join(links, "other-tool.exe");

  const dirs = new Set([pkgs, links, pkgDir, buildDir]);
  const files = new Set([nestedExe, strayFile, strayLink]);
  const tree = new Map([
    [pkgs, ["ffmpeg-notes.txt", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"]],
    [links, ["other-tool.exe"]],
    [pkgDir, ["ffmpeg-7.1-full_build"]],
  ]);
  const env = {
    isWin: true,
    pathEnv: "",
    localAppData: local,
    exists: (p) => files.has(p) || dirs.has(p),
    isDir: (p) => dirs.has(p),
    listDir: (p) => {
      if (!dirs.has(p)) throw new Error(`ENOTDIR: ${p}`);
      return tree.get(p) ?? [];
    },
  };

  assert.equal(findTool("ffmpeg", env), nestedExe);
  assert.equal(findTool("ffprobe", env), "ffprobe");

  // PATH wins when present.
  const pathDir = "C:\\tools\\bin";
  const pathExe = join(pathDir, "ffmpeg.exe");
  files.add(pathExe);
  assert.equal(findTool("ffmpeg", { ...env, pathEnv: `C:\\empty;${pathDir}` }), pathExe);
});

test("findTool checks standard Unix bin folders when not on PATH", () => {
  const hb = join("/opt/homebrew/bin", "ffmpeg");
  const found = findTool("ffmpeg", {
    isWin: false,
    pathEnv: "/custom/empty",
    exists: (p) => p === hb,
    isDir: () => false,
    listDir: () => [],
  });
  assert.equal(found, hb);
});

test("FLOW_MCP_FFMPEG and FLOW_MCP_FFPROBE env overrides win over findTool", () => {
  const prevFfmpeg = process.env.FLOW_MCP_FFMPEG;
  const prevFfprobe = process.env.FLOW_MCP_FFPROBE;
  try {
    process.env.FLOW_MCP_FFMPEG = "/custom/ffmpeg";
    process.env.FLOW_MCP_FFPROBE = "/custom/ffprobe";
    assert.equal(ffmpeg({ exists: () => false, isDir: () => false, listDir: () => [] }), "/custom/ffmpeg");
    assert.equal(ffprobe({ exists: () => false, isDir: () => false, listDir: () => [] }), "/custom/ffprobe");
  } finally {
    if (prevFfmpeg === undefined) delete process.env.FLOW_MCP_FFMPEG;
    else process.env.FLOW_MCP_FFMPEG = prevFfmpeg;
    if (prevFfprobe === undefined) delete process.env.FLOW_MCP_FFPROBE;
    else process.env.FLOW_MCP_FFPROBE = prevFfprobe;
  }
});

test("findTool skips empty, dot, and relative PATH entries", () => {
  const realBin = "C:\\tools\\bin";
  const realExe = join(realBin, "ffmpeg.exe");
  const relativeHit = join("relative\\bin", "ffmpeg.exe");
  const dotHit = join(".", "ffmpeg.exe");
  const seen = [];
  const winFound = findTool("ffmpeg", {
    isWin: true,
    pathEnv: `;.;relative\\bin;..\\parent;${realBin}`,
    localAppData: "C:\\none",
    exists: (p) => {
      seen.push(p);
      return p === dotHit || p === relativeHit || p === realExe;
    },
    isDir: () => false,
    listDir: () => [],
  });
  assert.equal(winFound, realExe);
  assert.ok(!seen.includes(dotHit), "must not check '.'");
  assert.ok(!seen.includes(relativeHit), "must not check relative PATH dir");

  const unixFound = findTool("ffmpeg", {
    isWin: false,
    pathEnv: ":.:./bin:relative:/usr/local/bin",
    exists: (p) => p === join(".", "ffmpeg") || p === join("./bin", "ffmpeg") || p === join("/usr/local/bin", "ffmpeg"),
    isDir: () => false,
    listDir: () => [],
  });
  assert.equal(unixFound, join("/usr/local/bin", "ffmpeg"));
});

test("psQuote doubles ASCII and typographic single quotes", () => {
  assert.equal(psQuote("plain"), "'plain'");
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(psQuote("a\u2018b\u2019c\u201Ad\u201Be"), "'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be'");
});

test("systemTool resolves Windows tools under System32 and returns bare name elsewhere", () => {
  const psPath = join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tarPath = join("C:\\Windows", "System32", "tar.exe");
  const cmdPath = join("C:\\Windows", "System32", "cmd.exe");
  const curlPath = join("C:\\Windows", "System32", "curl.exe");
  const present = new Set([psPath, tarPath, cmdPath, curlPath]);

  assert.equal(systemTool("powershell.exe", { isWin: true, systemRoot: "C:\\Windows", exists: (p) => present.has(p) }), psPath);
  assert.equal(systemTool("tar", { isWin: true, systemRoot: "C:\\Windows", exists: (p) => present.has(p) }), tarPath);
  assert.equal(systemTool("cmd", { isWin: true, systemRoot: "C:\\Windows", exists: (p) => present.has(p) }), cmdPath);
  assert.equal(systemTool("curl", { isWin: true, systemRoot: "C:\\Windows", exists: (p) => present.has(p) }), curlPath);
  assert.equal(systemTool("tar", { isWin: true, systemRoot: "C:\\Windows", exists: () => false }), "tar");
  assert.equal(systemTool("tar", { isWin: false }), "tar");

  if (process.platform === "win32") {
    assert.match(systemTool("powershell.exe"), /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.match(systemTool("cmd"), /System32[\\/]cmd\.exe$/i);
  } else {
    assert.equal(systemTool("tar"), "tar");
  }
});

test("walkExtractedFiles keeps regular files inside dest and skips symlinks", () => {
  const root = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow-walk-test-"));
  const dest = join(root, "extracted");
  const outside = join(root, "outside.txt");
  mkdirSync(join(dest, "sub"), { recursive: true });
  try {
    const keep1 = join(dest, "a.png");
    const keep2 = join(dest, "sub", "b.mp4");
    const hidden = join(dest, ".hidden");
    writeFileSync(keep1, "img");
    writeFileSync(keep2, "vid");
    writeFileSync(hidden, "dot");
    writeFileSync(outside, "secret");

    let symlinkCreated = false;
    try {
      symlinkSync(outside, join(dest, "escape.png"));
      symlinkCreated = true;
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
    }

    const found = walkExtractedFiles(dest);
    assert.equal(found.length, 2);
    assert.ok(found.some((p) => p.endsWith("a.png")));
    assert.ok(found.some((p) => p.endsWith("b.mp4")));
    if (symlinkCreated) {
      assert.ok(!found.some((p) => p.endsWith("escape.png")), "symlink must be skipped");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertAllowedUploadFile accepts recognised media bytes and refuses text, env, and zip files", () => {
  const root = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow-upload-gate-"));
  try {
    const png = join(root, "pic.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const mp4 = join(root, "clip.mp4");
    writeFileSync(mp4, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]));
    const mp3 = join(root, "song.mp3");
    writeFileSync(mp3, Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]));
    const envFile = join(root, ".env");
    writeFileSync(envFile, "API_KEY=secret\n");
    const zip = join(root, "bundle.zip");
    writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]));

    assert.equal(assertAllowedUploadFile(png), ".png");
    assert.equal(assertAllowedUploadFile(mp4), ".mp4");
    assert.equal(assertAllowedUploadFile(mp3), ".mp3");
    assert.throws(() => assertAllowedUploadFile(envFile), /Refusing to upload/i);
    assert.throws(() => assertAllowedUploadFile(zip), /Refusing to upload/i);
    assert.throws(() => assertAllowedUploadFile(root), /not a regular file/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("character look and voice stores reject prototype-pollution keys and ignore inherited properties", () => {
  const root = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow-char-store-"));
  const looksPath = join(root, "characters.json");
  const voicesPath = join(root, "voices.json");
  try {
    for (const bad of ["__proto__", "PROTOTYPE", "Constructor"]) {
      assert.throws(() => rememberCharacter(bad, "tall", looksPath), /cannot be used as a character name/i);
      assert.throws(() => rememberVoice(bad, "achird", voicesPath), /cannot be used as a character name/i);
      assert.equal(characterLook(bad, looksPath), undefined);
      assert.equal(characterVoice(bad, voicesPath), undefined);
    }
    assert.equal(characterLook("toString", looksPath), undefined);
    assert.equal(characterVoice("valueOf", voicesPath), undefined);

    rememberCharacter("Ines", "blue coat", looksPath);
    rememberVoice("Ines", "aoede", voicesPath);
    assert.equal(characterLook("ines", looksPath), "blue coat");
    assert.equal(characterVoice("INES", voicesPath), "aoede");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
