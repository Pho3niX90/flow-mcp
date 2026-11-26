import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCollectionTree, findCollection, normPath, parentPath, refOf, splitLibraryRef } from "../dist/library.js";

const TREE = buildCollectionTree([
  { id: "c-cast", depth: 0, name: "Cast" },
  { id: "c-places", depth: 0, name: "Places" },
  { id: "c-harbour", depth: 1, name: "Harbour" },
  { id: "c-docks", depth: 2, name: "Docks" },
  { id: "c-dup-a", depth: 1, name: "Refs" },
  { id: "c-other", depth: 0, name: "Props" },
  { id: "c-dup-b", depth: 1, name: "Refs" },
]);

test("buildCollectionTree derives nested paths from depth and clamps malformed depths", () => {
  assert.deepEqual(
    TREE.map((c) => [c.id, c.path, c.depth]),
    [
      ["c-cast", "Cast", 0],
      ["c-places", "Places", 0],
      ["c-harbour", "Places/Harbour", 1],
      ["c-docks", "Places/Harbour/Docks", 2],
      ["c-dup-a", "Places/Refs", 1],
      ["c-other", "Props", 0],
      ["c-dup-b", "Props/Refs", 1],
    ],
  );
  const clamped = buildCollectionTree([
    { id: "a", depth: 5, name: "Root" },
    { id: "b", depth: -2, name: "AlsoRoot" },
    { id: "", depth: 0, name: "NoId" },
    { id: "c", depth: 0, name: "" },
  ]);
  assert.deepEqual(
    clamped.map((c) => [c.id, c.path, c.depth]),
    [
      ["a", "Root", 0],
      ["b", "AlsoRoot", 0],
    ],
  );
});

test("normPath, parentPath, and refOf handle Library paths cleanly", () => {
  assert.equal(normPath(" Places / Harbour / "), "places/harbour");
  assert.equal(parentPath("Places/Harbour/Docks"), "Places/Harbour");
  assert.equal(parentPath("Cast"), "");
  assert.equal(refOf({ name: "Hero", path: "Cast" }), "Cast/Hero");
  assert.equal(refOf({ name: "Solo" }), "Solo");
});

test("findCollection matches full paths, unique bare names, and refuses ambiguous or missing collections", () => {
  assert.equal(findCollection(TREE, "places/harbour/docks").id, "c-docks");
  assert.equal(findCollection(TREE, "Harbour").id, "c-harbour");
  assert.throws(() => findCollection(TREE, "Refs"), /Several collections are called "Refs"/);
  assert.throws(() => findCollection(TREE, "Missing"), /No Library collection "Missing"/);
});

test("splitLibraryRef resolves deepest collection prefix and rejects bare collections cleanly", () => {
  assert.deepEqual(splitLibraryRef(TREE, "Places/Harbour/Docks/Pier at dusk"), {
    collection: TREE[3],
    title: "Pier at dusk",
  });
  // Title containing a slash falls back to deepest matching collection.
  assert.deepEqual(splitLibraryRef(TREE, "Places/Harbour/Shot 1/2"), {
    collection: TREE[2],
    title: "Shot 1/2",
  });
  // Bare collection path yields empty title so callers reject downloading a collection via assets[].
  assert.deepEqual(splitLibraryRef(TREE, "Places/Harbour/"), {
    collection: TREE[2],
    title: "",
  });
});

test("splitLibraryRef resolves strictly against the Library tree and never matches filesystem-like paths", () => {
  assert.equal(splitLibraryRef(TREE, "../../etc/passwd"), undefined);
  assert.equal(splitLibraryRef(TREE, "/etc/passwd"), undefined);
  assert.equal(splitLibraryRef(TREE, "C:/Windows/System32/cmd.exe"), undefined);
  assert.equal(splitLibraryRef(TREE, "../Cast/Hero"), undefined);
  assert.equal(splitLibraryRef(TREE, "NoSuchCollection/Item"), undefined);
  assert.equal(splitLibraryRef(TREE, "///"), undefined);
});
