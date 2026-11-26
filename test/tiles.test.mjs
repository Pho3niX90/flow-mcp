import assert from "node:assert/strict";
import { test } from "node:test";

import { ASB_TOKEN_RE, MEDIA_UUID_RE, OUR_TITLE, extractMediaIdFromUrl } from "../dist/tiles.js";

test("extractMediaIdFromUrl reads UUIDs from Flow media URLs", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(extractMediaIdFromUrl(`https://flow-content.google/image/${uuid}`), uuid);
  assert.equal(extractMediaIdFromUrl(`https://flow-content.google/video/${uuid}?alt=media`), uuid);
});

test("extractMediaIdFromUrl reads /asb/ tokens and drops variant suffixes", () => {
  const token = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcdefghij";
  assert.equal(extractMediaIdFromUrl(`https://flow.google.com/asb/${token}=s512-rw`), token);
  assert.equal(extractMediaIdFromUrl(`https://flow.google.com/asb/${token}=mm,22,15`), token);
  assert.equal(extractMediaIdFromUrl(`https://flow.google.com/asb/${token}`), token);
  // Short /asb/ segments and unrelated URLs are ignored.
  assert.equal(extractMediaIdFromUrl("https://flow.google.com/asb/too-short"), undefined);
  assert.equal(extractMediaIdFromUrl("https://flow.google.com/assets/logo.png"), undefined);
  assert.equal(extractMediaIdFromUrl(""), undefined);
});

test("serialized regex sources stay equivalent to MEDIA_UUID_RE and ASB_TOKEN_RE", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const token = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcdefghij";
  const reUuid = new RegExp(MEDIA_UUID_RE.source);
  const reAsb = new RegExp(ASB_TOKEN_RE.source);
  assert.equal(`https://flow-content.google/image/${uuid}`.match(reUuid)?.[0], uuid);
  assert.equal(`https://flow.google.com/asb/${token}=s512-rw`.match(reAsb)?.[1], token);
});

test("OUR_TITLE matches flow-mcp generated titles and ignores Flow auto titles", () => {
  assert.equal(OUR_TITLE.test("MyFilm-scene-01"), true);
  assert.equal(OUR_TITLE.test("MyFilm-scene-12-v2"), true);
  assert.equal(OUR_TITLE.test("Project_A-clip-003"), true);
  assert.equal(OUR_TITLE.test("Promo-edit-4-v1"), true);
  assert.equal(OUR_TITLE.test("PROMO-SCENE-09"), true);
  assert.equal(OUR_TITLE.test("Man posing for portrait"), false);
  assert.equal(OUR_TITLE.test("Woman climbing granite wall"), false);
  assert.equal(OUR_TITLE.test("scene-01"), false);
  assert.equal(OUR_TITLE.test("MyFilm-scene-01-extra"), false);
});
