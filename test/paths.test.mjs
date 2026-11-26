import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { test } from "node:test";

import { projectDirIn, projectFolderName } from "../dist/paths.js";

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
