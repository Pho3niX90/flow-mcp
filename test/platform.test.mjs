import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ffmpeg, ffprobe, findTool, moveFile } from "../dist/platform.js";

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
