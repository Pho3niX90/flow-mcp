import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MUSIC_OBSERVED_PRICE,
  checkMusicCreditsBefore,
  chooseMusicDownloadRoute,
  classifyMusicSignedIn,
  classifyMusicStatus,
  formatMusicLength,
  isAllowedMusicMediaUrl,
  matchesMusicModel,
  measureMusicSpend,
  parseMusicClip,
  parseMusicClipsResponse,
  parseMusicCredits,
  parseMusicPlan,
  resolveMusicSongQuery,
  validateMusicBpm,
  validateMusicFormats,
  validateMusicSeed,
} from "../dist/music-parse.js";

test("formatMusicLength formats 60..180 seconds as M:SS and refuses out-of-range or non-integers", () => {
  assert.equal(formatMusicLength(60), "1:00");
  assert.equal(formatMusicLength(65), "1:05");
  assert.equal(formatMusicLength(90), "1:30");
  assert.equal(formatMusicLength(125), "2:05");
  assert.equal(formatMusicLength(180), "3:00");

  for (const bad of [0, 30, 59, 181, 300, -10, 90.5, Number.NaN]) {
    assert.throws(() => formatMusicLength(bad), /60 to 180/);
  }
});

test("validateMusicBpm, validateMusicSeed, and validateMusicFormats validate inputs cleanly", () => {
  assert.equal(validateMusicBpm(96), "96");
  assert.equal(validateMusicBpm(20), "20");
  assert.equal(validateMusicBpm(400), "400");
  assert.throws(() => validateMusicBpm(19), /20 to 400/);
  assert.throws(() => validateMusicBpm(401), /20 to 400/);
  assert.throws(() => validateMusicBpm(96.5), /20 to 400/);

  assert.equal(validateMusicSeed("123456"), "123456");
  assert.equal(validateMusicSeed(42), "42");
  assert.throws(() => validateMusicSeed("abc"), /digits only/);
  assert.throws(() => validateMusicSeed("12 34"), /digits only/);
  assert.throws(() => validateMusicSeed(""), /digits only/);

  assert.deepEqual(validateMusicFormats(undefined), ["m4a"]);
  assert.deepEqual(validateMusicFormats(["wav", "m4a", "wav"]), ["wav", "m4a"]);
  assert.throws(() => validateMusicFormats(["flac"]), /Unsupported music format/);
});

test("parseMusicClip and parseMusicClipsResponse handle full and partial API shapes", () => {
  const full = {
    id: "clip-123",
    title: "Midnight Groove",
    duration: { status: "completed", value: "168.85333333333332" },
    lyrics: { status: "completed", value: { id: "lyr-1", text: "[Instrumental]" } },
    privacy: "unlisted",
    created_at: "2026-11-26T10:00:00Z",
    operation: {
      op_type: "audio__create_song",
      conversation_id: "conv-1",
      sound_prompt: "warm lo-fi jazz beat, dusty rhodes",
      title: "Midnight Groove",
      seed: 98765,
    },
    audio_url: "https://example.com/a.m4a",
    wav_url: "https://example.com/a.wav",
  };
  assert.deepEqual(parseMusicClip(full), {
    id: "clip-123",
    title: "Midnight Groove",
    seconds: 169,
    lyrics: "[Instrumental]",
    sound: "warm lo-fi jazz beat, dusty rhodes",
    seed: "98765",
    created_at: "2026-11-26T10:00:00Z",
    audio_url: "https://example.com/a.m4a",
    wav_url: "https://example.com/a.wav",
    has_wav: true,
  });

  // Minimal / missing fields default cleanly without throwing.
  assert.deepEqual(parseMusicClip({ id: "clip-min" }), {
    id: "clip-min",
    title: "Untitled",
    has_wav: false,
  });
  assert.equal(parseMusicClip({}), null);
  assert.equal(parseMusicClip(null), null);

  // Supports both array (library) and object-map (POST /__api/clips) shapes.
  assert.equal(parseMusicClipsResponse({ clips: [full, { id: "clip-2" }] }).length, 2);
  assert.equal(parseMusicClipsResponse({ clips: { "clip-123": full, "clip-2": { id: "clip-2" } } }).length, 2);
  assert.deepEqual(parseMusicClipsResponse({}), []);
});

test("classifyMusicStatus distinguishes complete, working, and failed payloads", () => {
  assert.deepEqual(
    classifyMusicStatus({
      operation_id: "op-1",
      status: "complete",
      progress: null,
      clip_id: "clip-abc",
      error_type: null,
      error_message: null,
    }),
    { state: "complete", clipId: "clip-abc" },
  );
  assert.deepEqual(classifyMusicStatus({ status: "in_progress", progress: 0.4 }), { state: "working", progress: 0.4 });
  assert.deepEqual(classifyMusicStatus(null), { state: "working" });
  assert.deepEqual(
    classifyMusicStatus({ status: "failed", error_type: "POLICY", error_message: "Prompt blocked" }),
    { state: "failed", reason: "POLICY: Prompt blocked" },
  );
  assert.deepEqual(classifyMusicStatus({ status: "complete", error_message: "Audio failed" }), {
    state: "failed",
    reason: "Audio failed",
  });
});

test("matchesMusicModel matches Lyria model labels by case-insensitive prefix and shorthand", () => {
  const flagship = "Lyria 3.5\nTop performing, flagship model";
  const legacy = "Lyria 3 Pro\nLegacy model";

  assert.equal(matchesMusicModel(flagship, "lyria 3.5"), true);
  assert.equal(matchesMusicModel(flagship, "Lyria 3.5"), true);
  assert.equal(matchesMusicModel(flagship, "3.5"), true);
  assert.equal(matchesMusicModel(legacy, "lyria 3 pro"), true);
  assert.equal(matchesMusicModel(legacy, "3 pro"), true);

  assert.equal(matchesMusicModel(flagship, "lyria 3 pro"), false);
  assert.equal(matchesMusicModel(flagship, "3"), false);
  assert.equal(matchesMusicModel(legacy, "3.5"), false);
  assert.equal(matchesMusicModel(flagship, ""), false);
});

test("classifyMusicSignedIn decides from visibility flags", () => {
  assert.equal(classifyMusicSignedIn({ logInVisible: true, signedInNavVisible: false }), false);
  assert.equal(classifyMusicSignedIn({ logInVisible: true, signedInNavVisible: true }), false);
  assert.equal(classifyMusicSignedIn({ logInVisible: false, signedInNavVisible: true }), true);
  assert.equal(classifyMusicSignedIn({ logInVisible: false, signedInNavVisible: false }), null);
});

test("parseMusicCredits, parseMusicPlan, credit guards, and resolveMusicSongQuery work cleanly", () => {
  assert.deepEqual(parseMusicCredits({ data: { tokens_remaining: 100, credits_remaining: 30505 } }), {
    credits_remaining: 30505,
    tokens_remaining: 100,
  });
  assert.deepEqual(parseMusicCredits({}), {});
  assert.equal(parseMusicPlan({ data: { subscription_tier: "AI Pro" } }), "AI Pro");
  assert.equal(parseMusicPlan({ data: { subscription_plan: "Free" } }), "Free");
  assert.equal(parseMusicPlan({}), undefined);

  assert.equal(MUSIC_OBSERVED_PRICE, 5);
  assert.doesNotThrow(() => checkMusicCreditsBefore(10, 30505));
  assert.doesNotThrow(() => checkMusicCreditsBefore(5, 5));
  assert.throws(() => checkMusicCreditsBefore(4, 100), /observed price of 5/);
  assert.throws(() => checkMusicCreditsBefore(10, 4), /4 credits left/);
  assert.equal(measureMusicSpend(30510, 30505), 5);
  assert.equal(measureMusicSpend(30510, undefined), undefined);
  assert.equal(measureMusicSpend(10, 20), undefined);

  const clips = [
    { id: "id-1", title: "Sunset", has_wav: true },
    { id: "id-2", title: "Untitled", has_wav: false },
    { id: "id-3", title: "Untitled", has_wav: true },
  ];
  assert.deepEqual(resolveMusicSongQuery(clips, "id-2"), { ok: true, clip: clips[1] });
  assert.deepEqual(resolveMusicSongQuery(clips, "Sunset"), { ok: true, clip: clips[0] });
  const ambig = resolveMusicSongQuery(clips, "Untitled");
  assert.equal(ambig.ok, false);
  if (!ambig.ok) {
    assert.match(ambig.error, /id-2/);
    assert.match(ambig.error, /id-3/);
  }
  const missing = resolveMusicSongQuery(clips, "Nope");
  assert.equal(missing.ok, false);
});

test("isAllowedMusicMediaUrl permits only allow-listed https hosts and rejects look-alikes and non-https schemes", () => {
  assert.equal(isAllowedMusicMediaUrl("https://storage.googleapis.com/producer-app-public/clips/abc.m4a"), true);
  assert.equal(isAllowedMusicMediaUrl("https://STORAGE.GOOGLEAPIS.COM/producer-app-public/clips/abc.wav"), true);

  for (const bad of [
    undefined,
    "",
    "not a url",
    "http://storage.googleapis.com/producer-app-public/clips/abc.m4a",
    "blob:https://www.flowmusic.app/1234",
    "data:audio/mp4;base64,AAAA",
    "file:///etc/passwd",
    "https://storage.googleapis.com.evil.example/clips/abc.m4a",
    "https://evilstorage.googleapis.com/clips/abc.m4a",
    "https://example.com/clips/abc.m4a",
    "https://user:pass@storage.googleapis.com/clips/abc.m4a",
  ]) {
    assert.equal(isAllowedMusicMediaUrl(bad), false, `expected reject for ${String(bad)}`);
  }
});

test("chooseMusicDownloadRoute picks direct, convert, or menu fallback per format and clip record", () => {
  const m4aUrl = "https://storage.googleapis.com/producer-app-public/clips/abc.m4a";
  const wavUrl = "https://storage.googleapis.com/producer-app-public/clips/abc.wav";

  // Full clip record with FFmpeg available.
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: m4aUrl, wav_url: wavUrl }, "m4a", true), { route: "direct", url: m4aUrl });
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: m4aUrl, wav_url: wavUrl }, "wav", true), { route: "direct", url: wavUrl });
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: m4aUrl, wav_url: wavUrl }, "mp3", true), { route: "convert", url: m4aUrl });

  // Without FFmpeg: m4a/wav still go direct; mp3 falls back to menu with reason no_ffmpeg.
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: m4aUrl, wav_url: wavUrl }, "m4a", false), { route: "direct", url: m4aUrl });
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: m4aUrl, wav_url: wavUrl }, "wav", false), { route: "direct", url: wavUrl });
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: m4aUrl, wav_url: wavUrl }, "mp3", false), { route: "menu", reason: "no_ffmpeg" });

  // Missing URLs fall back to menu with reason no_url.
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: m4aUrl }, "wav", true), { route: "menu", reason: "no_url" });
  assert.deepEqual(chooseMusicDownloadRoute({}, "m4a", true), { route: "menu", reason: "no_url" });
  assert.deepEqual(chooseMusicDownloadRoute({}, "mp3", true), { route: "menu", reason: "no_url" });

  // Untrusted host or non-https URL falls back to menu with reason untrusted_url.
  assert.deepEqual(chooseMusicDownloadRoute({ audio_url: "https://storage.googleapis.com.evil.example/a.m4a" }, "m4a", true), {
    route: "menu",
    reason: "untrusted_url",
  });
  assert.deepEqual(chooseMusicDownloadRoute({ wav_url: "http://storage.googleapis.com/a.wav" }, "wav", true), {
    route: "menu",
    reason: "untrusted_url",
  });
});
