import assert from "node:assert/strict";
import { test } from "node:test";

import { FLOW_URL, MUSIC_URL, SITES, isSiteUrl, pickSiteUrlIndex } from "../dist/sites.js";

test("site host patterns match only their own domains and reject look-alikes and each other", () => {
  assert.equal(FLOW_URL, "https://flow.google.com/");
  assert.equal(MUSIC_URL, "https://www.flowmusic.app/");
  assert.equal(SITES.flow.url, FLOW_URL);
  assert.equal(SITES.music.url, MUSIC_URL);

  for (const ok of [
    "https://flow.google.com/",
    "https://flow.google.com",
    "https://flow.google.com/project/12345678-1234-1234-1234-123456789abc?hl=en",
    "https://labs.google/fx",
    "https://labs.google/fx/tools/flow",
  ]) {
    assert.equal(isSiteUrl("flow", ok), true, `flow should match ${ok}`);
    assert.equal(isSiteUrl("music", ok), false, `music must not match ${ok}`);
  }

  for (const ok of [
    "https://www.flowmusic.app/",
    "https://www.flowmusic.app",
    "https://www.flowmusic.app/chat/abc?x=1",
    "https://flowmusic.app/",
    "https://flowmusic.app",
    "https://flowmusic.app/songs",
  ]) {
    assert.equal(isSiteUrl("music", ok), true, `music should match ${ok}`);
    assert.equal(isSiteUrl("flow", ok), false, `flow must not match ${ok}`);
  }

  for (const bad of [
    "https://flowmusic.app.evil.example/",
    "https://www.flowmusic.app.evil.example/chat",
    "https://notflowmusic.app/",
    "https://sub.flowmusic.app/",
    "http://www.flowmusic.app/",
    "https://flow.google.com.evil.example/",
    "https://labs.google/fx-evil",
    "https://example.com/?next=https://www.flowmusic.app/",
    "https://example.com/?next=https://flow.google.com/",
    "about:blank",
  ]) {
    assert.equal(isSiteUrl("flow", bad), false, `flow must reject ${bad}`);
    assert.equal(isSiteUrl("music", bad), false, `music must reject ${bad}`);
  }
});

test("pickSiteUrlIndex selects the right page per site without cross-matching", () => {
  const urls = [
    "https://www.flowmusic.app/",
    "https://flow.google.com/about",
    "https://flow.google.com/?hl=en",
    "https://flow.google.com/project/11111111-1111-1111-1111-111111111111?hl=en",
    "https://flow.google.com/project/22222222-2222-2222-2222-222222222222?hl=en",
  ];

  // Flow prefers project tab, ignores Flow Music and /about.
  assert.equal(pickSiteUrlIndex("flow", urls), 3);
  assert.equal(pickSiteUrlIndex("flow", urls, { wantedProject: "22222222-2222-2222-2222-222222222222" }), 4);
  assert.equal(pickSiteUrlIndex("flow", urls.slice(0, 3)), 2);
  assert.equal(pickSiteUrlIndex("flow", urls.slice(0, 2)), 1);
  assert.equal(pickSiteUrlIndex("flow", [urls[0]]), -1);

  // Music picks Flow Music only and never falls back to a Flow tab.
  assert.equal(pickSiteUrlIndex("music", urls), 0);
  assert.equal(pickSiteUrlIndex("music", urls.slice(1)), -1);
});
