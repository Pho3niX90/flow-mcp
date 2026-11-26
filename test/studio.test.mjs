import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../studio/index.html", import.meta.url), "utf8");
const coreSrc = readFileSync(new URL("../src/core.ts", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

test("studio/index.html inline script parses cleanly", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "expected a single inline <script> block");
  assert.doesNotThrow(() => new Function(scripts[0][1]));
});

test("studio/index.html has unique element ids", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dupes = [];
  for (const id of ids) {
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `duplicate element ids: ${dupes.join(", ")}`);
});

test("studio/index.html defines all nine tabs in order with matching panels", () => {
  const navMatch = html.match(/<nav\b[^>]*\bid="tabs"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(navMatch, "expected <nav id=\"tabs\">");
  const tabs = [...navMatch[1].matchAll(/<button\b[^>]*\bdata-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["cast", "frames", "shots", "narrate", "music", "restyle", "cut", "captions", "library"]);

  const panels = [...html.matchAll(/<section\b[^>]*\bdata-panel="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(panels, tabs);
});

test("every api() call in studio/index.html matches a Core method in src/core.ts", () => {
  const coreBlock = coreSrc.match(/export interface Core \{([\s\S]*?)\n\}/);
  assert.ok(coreBlock, "expected export interface Core in src/core.ts");
  const coreMethods = new Set([...coreBlock[1].matchAll(/^\s*(\w+)\s*\(/gm)].map((m) => m[1]));
  assert.ok(coreMethods.size > 20, "expected Core methods to be parsed");

  const apiCalls = [...new Set([...html.matchAll(/\bapi\(\s*["'](\w+)["']/g)].map((m) => m[1]))];
  assert.ok(apiCalls.length > 0, "expected api() calls in studio/index.html");

  const unknown = apiCalls.filter((name) => !coreMethods.has(name));
  assert.deepEqual(unknown, [], `unknown Core API methods called by studio/index.html: ${unknown.join(", ")}`);

  for (const musicMethod of ["music_status", "music", "music_songs", "music_download"]) {
    assert.ok(apiCalls.includes(musicMethod), `expected studio/index.html to call api("${musicMethod}")`);
  }
});

test("src/server.ts MIME table covers Flow Music audio formats", () => {
  const mimeBlock = serverSrc.match(/const MIME:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(mimeBlock, "expected MIME table in src/server.ts");
  for (const [ext, type] of [
    [".m4a", "audio/mp4"],
    [".mp3", "audio/mpeg"],
    [".wav", "audio/wav"],
  ]) {
    assert.match(mimeBlock[1], new RegExp(`"${ext.replace(".", "\\.")}":\\s*"${type}"`));
  }
});
