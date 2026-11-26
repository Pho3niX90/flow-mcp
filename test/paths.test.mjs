import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { test } from "node:test";

import { isProjectGridUrl, projectDirIn, projectFolderName, validateProjectTitle } from "../dist/paths.js";

test("a project name becomes one safe folder name", () => {
  assert.equal(projectFolderName("ep04 lightbulb cartel"), "ep04_lightbulb_cartel");
  assert.equal(projectFolderName("v1.2-final"), "v1.2-final");
  assert.equal(projectFolderName("../../etc"), ".._.._etc");
  assert.equal(projectFolderName("a/b\\c"), "a_b_c");
  assert.equal(projectFolderName("name."), "name.");
});

test("names that would climb out of the films folder are refused", () => {
  for (const bad of ["", ".", "..", "...", " "]) {
    if (bad === " ") assert.equal(projectFolderName(bad), "_");
    else assert.throws(() => projectFolderName(bad), /cannot be used as a project name/);
  }
});

test("a project folder is always directly inside the films folder", () => {
  const root = resolve("films-root");
  for (const name of ["ok", "../up", "..\\up", "a/../../b", "C:\\Windows", "/etc/passwd", "..hidden"]) {
    const dir = projectDirIn(root, name);
    assert.ok(dir.startsWith(root + sep), `${name} -> ${dir}`);
    assert.ok(!dir.slice(root.length + 1).includes(sep), `${name} -> ${dir}`);
  }
});

test("validateProjectTitle trims valid titles and rejects empty, multiline, or overly long ones", () => {
  assert.equal(validateProjectTitle("  Desk lamp ad  "), "Desk lamp ad");
  assert.equal(validateProjectTitle("a".repeat(100)), "a".repeat(100));
  assert.throws(() => validateProjectTitle(""), /cannot be empty/);
  assert.throws(() => validateProjectTitle("   \t  "), /cannot be empty/);
  assert.throws(() => validateProjectTitle("line 1\nline 2"), /single line/);
  assert.throws(() => validateProjectTitle("line 1\rline 2"), /single line/);
  assert.throws(() => validateProjectTitle("a".repeat(101)), /100 characters/);
});

test("isProjectGridUrl matches only the exact project grid path and rejects item subpages", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(isProjectGridUrl(`https://flow.google.com/project/${id}`), true);
  assert.equal(isProjectGridUrl(`https://flow.google.com/project/${id}?hl=en`), true);
  assert.equal(isProjectGridUrl(`https://flow.google.com/project/${id}/edit/abcdef`), false);
  assert.equal(isProjectGridUrl(`https://flow.google.com/project/${id}/character/123`), false);
  assert.equal(isProjectGridUrl(`https://flow.google.com/project/${id}/`), false);
  assert.equal(isProjectGridUrl("https://flow.google.com/?hl=en"), false);
  assert.equal(isProjectGridUrl("not a url"), false);
});
