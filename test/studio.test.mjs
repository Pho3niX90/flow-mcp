import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../studio/index.html", import.meta.url), "utf8");
const coreSrc = readFileSync(new URL("../src/core.ts", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

function skipStringOrComment(src, i) {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === "/" && next === "/") {
    const nl = src.indexOf("\n", i + 2);
    return nl === -1 ? src.length : nl + 1;
  }
  if (ch === "/" && next === "*") {
    const end = src.indexOf("*/", i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (ch === "'" || ch === '"') {
    i++;
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === ch) return i + 1;
      i++;
    }
    return src.length;
  }
  if (ch === "`") {
    i++;
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") {
        i = findMatching(src, i + 1, "{", "}") + 1;
        continue;
      }
      if (src[i] === "`") return i + 1;
      i++;
    }
    return src.length;
  }
  return -1;
}

function findMatching(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; ) {
    const jumped = skipStringOrComment(src, i);
    if (jumped !== -1) { i = jumped; continue; }
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error(`Unmatched ${openCh} at index ${openIdx}`);
}

function splitTopLevel(body) {
  const parts = [];
  let start = 0;
  let paren = 0, brace = 0, bracket = 0;
  for (let i = 0; i < body.length; ) {
    const jumped = skipStringOrComment(body, i);
    if (jumped !== -1) { i = jumped; continue; }
    const ch = body[i];
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
    else if (ch === "," && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stripLeadingComments(s) {
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) {
      i = skipStringOrComment(s, i);
      continue;
    }
    break;
  }
  return s.slice(i);
}

function extractObjectKeys(objText, spreadAliases = {}) {
  const trimmed = objText.trim();
  if (!trimmed.startsWith("{")) return [];
  const closeIdx = findMatching(trimmed, 0, "{", "}");
  const inner = trimmed.slice(1, closeIdx);
  const keys = [];
  for (const rawPart of splitTopLevel(inner)) {
    const part = stripLeadingComments(rawPart);
    if (!part) continue;
    if (part.startsWith("...")) {
      const expr = part.slice(3).trim();
      if (spreadAliases[expr]) {
        keys.push(...spreadAliases[expr]);
        continue;
      }
      // Inspect inline object literals inside conditional spreads like ...(cond ? { foo: 1 } : {})
      for (let i = 0; i < expr.length; ) {
        const jumped = skipStringOrComment(expr, i);
        if (jumped !== -1) { i = jumped; continue; }
        if (expr[i] === "{") {
          const end = findMatching(expr, i, "{", "}");
          keys.push(...extractObjectKeys(expr.slice(i, end + 1), spreadAliases));
          i = end + 1;
          continue;
        }
        i++;
      }
      continue;
    }
    const keyMatch = part.match(/^(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*(?::|$)/);
    if (keyMatch) keys.push(keyMatch[1] ?? keyMatch[2]);
  }
  return keys;
}

function parseCoreShapes(src) {
  const capMatch = src.match(/const captionFields\s*=\s*\{/);
  assert.ok(capMatch, "expected const captionFields in src/core.ts");
  const capOpen = capMatch.index + capMatch[0].length - 1;
  const capClose = findMatching(src, capOpen, "{", "}");
  const captionKeys = extractObjectKeys(src.slice(capOpen, capClose + 1));

  const shapesMatch = src.match(/export const shapes\s*=\s*\{/);
  assert.ok(shapesMatch, "expected export const shapes in src/core.ts");
  const open = shapesMatch.index + shapesMatch[0].length - 1;
  const close = findMatching(src, open, "{", "}");
  const body = src.slice(open + 1, close);

  const result = new Map();
  for (const rawEntry of splitTopLevel(body)) {
    const entry = stripLeadingComments(rawEntry);
    const m = entry.match(/^(\w+)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    const [, name, val] = m;
    const rhs = stripLeadingComments(val);
    if (rhs === "captionFields") {
      result.set(name, new Set(captionKeys));
    } else if (rhs.startsWith("{")) {
      const end = findMatching(rhs, 0, "{", "}");
      result.set(name, new Set(extractObjectKeys(rhs.slice(0, end + 1), { captionFields: captionKeys })));
    }
  }
  return result;
}

function extractStudioApiLiteralCalls(script) {
  const calls = [];
  const re = /\bapi\(\s*["'](\w+)["']\s*,/g;
  let m;
  while ((m = re.exec(script))) {
    const method = m[1];
    let i = m.index + m[0].length;
    const callClose = findMatching(script, script.indexOf("(", m.index), "(", ")");
    const argSlice = stripLeadingComments(script.slice(i, callClose));
    // Direct object literal or ternary of object literals: api("x", cond ? { ... } : { ... })
    if (argSlice.startsWith("{")) {
      const end = findMatching(argSlice, 0, "{", "}");
      calls.push({ method, keys: extractObjectKeys(argSlice.slice(0, end + 1)) });
    } else if (argSlice.includes("?") && argSlice.includes("{")) {
      const q = argSlice.indexOf("?");
      const branches = argSlice.slice(q + 1);
      const keys = [];
      for (let j = 0; j < branches.length; ) {
        const jumped = skipStringOrComment(branches, j);
        if (jumped !== -1) { j = jumped; continue; }
        if (branches[j] === "{") {
          const end = findMatching(branches, j, "{", "}");
          keys.push(...extractObjectKeys(branches.slice(j, end + 1)));
          j = end + 1;
          continue;
        }
        j++;
      }
      if (keys.length) calls.push({ method, keys });
    }
  }
  return calls;
}

const scriptMatch = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
const scriptSrc = scriptMatch ? scriptMatch[1] : "";

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

  for (const expected of [
    "music_status", "music", "music_songs", "music_download",
    "projects", "open_project", "rename_project", "new_project",
    "cutout", "accounts", "image_models", "rename",
  ]) {
    assert.ok(apiCalls.includes(expected), `expected studio/index.html to call api("${expected}")`);
  }
});

test("ACCOUNT_METHODS in studio/index.html matches every shape in src/core.ts that accepts account", () => {
  const coreShapes = parseCoreShapes(coreSrc);
  const expected = [...coreShapes.entries()]
    .filter(([, keys]) => keys.has("account"))
    .map(([name]) => name)
    .sort();
  assert.ok(expected.length >= 20, "expected account-scoped shapes in src/core.ts");

  const setMatch = scriptSrc.match(/const ACCOUNT_METHODS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(setMatch, "expected const ACCOUNT_METHODS in studio/index.html");
  const actual = [...setMatch[1].matchAll(/["'](\w+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(actual, expected);
});

test("every literal-object api() call in studio/index.html uses only valid top-level keys from src/core.ts shapes", () => {
  const coreShapes = parseCoreShapes(coreSrc);
  const calls = extractStudioApiLiteralCalls(scriptSrc);
  assert.ok(calls.length >= 25, `expected at least 25 literal-object api() calls, found ${calls.length}`);

  const methodsChecked = new Set();
  for (const { method, keys } of calls) {
    const allowed = coreShapes.get(method);
    assert.ok(allowed, `expected shape for api("${method}") in src/core.ts`);
    methodsChecked.add(method);
    const bad = keys.filter((k) => !allowed.has(k));
    assert.deepEqual(bad, [], `api("${method}") passed unknown top-level key(s): ${bad.join(", ")}`);
  }

  for (const m of [
    "open_project", "rename_project", "new_project",
    "generate", "agent", "cutout",
    "accounts", "image_models",
    "characters", "character", "character_edit",
    "assets", "download", "rename", "trash",
    "music", "music_songs", "music_download",
  ]) {
    assert.ok(methodsChecked.has(m), `expected literal-object validation to cover api("${m}")`);
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
