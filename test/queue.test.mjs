import assert from "node:assert/strict";
import { test } from "node:test";

import { JobQueue } from "../dist/queue.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for queue condition");
}

const baseParams = (stem, extra = {}) => ({
  prompt: `Prompt ${stem}`,
  type: "image",
  max_credits: 0,
  output_dir: "/tmp/out",
  file_stem: stem,
  ...extra,
});

test("JobQueue runs different accounts in parallel while keeping each account strictly serial", async () => {
  let activeTotal = 0;
  let maxTotal = 0;
  const activePerAccount = new Map();
  let maxPerAccount = 0;
  const ranOn = new Map();

  const queue = new JobQueue(
    async (job, account) => {
      activeTotal++;
      maxTotal = Math.max(maxTotal, activeTotal);
      const cur = (activePerAccount.get(account) ?? 0) + 1;
      activePerAccount.set(account, cur);
      maxPerAccount = Math.max(maxPerAccount, cur);
      ranOn.set(job.id, account);
      await sleep(40);
      activePerAccount.set(account, (activePerAccount.get(account) ?? 1) - 1);
      activeTotal--;
      return [`${job.params.file_stem}.png`];
    },
    {
      accounts: () => ["main", "acc2"],
      ready: async () => undefined,
      pauseMinMs: 0,
      pauseMaxMs: 0,
    },
  );

  const jobs = [queue.add(baseParams("scene-01")), queue.add(baseParams("scene-02")), queue.add(baseParams("scene-03")), queue.add(baseParams("scene-04"))];
  await waitUntil(() => jobs.every((j) => j.status === "done"));

  assert.equal(maxTotal, 2, "expected two accounts to run concurrently");
  assert.equal(maxPerAccount, 1, "expected each account to stay strictly serial");
  assert.equal(new Set(ranOn.values()).size, 2);
});

test("JobQueue waits for dependencies, propagates failures, and handles disabled or unready accounts", async () => {
  const order = [];
  const queue = new JobQueue(
    async (job, account) => {
      order.push(`${job.params.file_stem}@${account}`);
      if (job.params.file_stem === "fail-me") throw new Error("boom");
      await sleep(25);
      return [`${job.params.file_stem}.png`];
    },
    {
      accounts: () => ["main", "acc2"],
      ready: async (account) => (account === "acc2" ? "acc2 not signed in" : undefined),
      pauseMinMs: 0,
      pauseMaxMs: 0,
    },
  );

  // Unpinned work skips not-ready acc2 and runs on main.
  const first = queue.add(baseParams("scene-01"));
  const second = queue.add(baseParams("scene-02", { reference_from: first.id }));
  // Dependency failure fails downstream job cleanly.
  const failing = queue.add(baseParams("fail-me"));
  const dependent = queue.add(baseParams("after-fail", { matte_from: failing.id }));
  // Disabled account pin fails cleanly.
  const disabled = queue.add(baseParams("pinned-off", { account: "disabled_acc" }));

  await waitUntil(() => [first, second, failing, dependent, disabled].every((j) => j.status === "done" || j.status === "failed"));

  assert.equal(first.status, "done");
  assert.equal(second.status, "done");
  assert.equal(first.account, "main");
  assert.equal(second.account, "main");
  assert.ok(order.indexOf("scene-01@main") < order.indexOf("scene-02@main"));

  assert.equal(failing.status, "failed");
  assert.equal(dependent.status, "failed");
  assert.match(dependent.error ?? "", /builds on job/);

  assert.equal(disabled.status, "failed");
  assert.match(disabled.error ?? "", /disabled/);
});

test("JobQueue groups consecutive parallel image scenes into batches of up to 6 inside per-account workers", async () => {
  const batches = [];
  const singles = [];

  const queue = new JobQueue(
    async (job, account) => {
      singles.push(`${job.params.file_stem}@${account}`);
      return [`${job.params.file_stem}.png`];
    },
    {
      accounts: () => ["main", "acc2"],
      ready: async () => undefined,
      pauseMinMs: 0,
      pauseMaxMs: 0,
      batchRunner: async (jobs, account) => {
        batches.push({ account, stems: jobs.map((j) => j.params.file_stem) });
        await sleep(30);
        return jobs.map((j) => (j.params.file_stem === "scene-03" ? new Error("scene 3 failed") : [`${j.params.file_stem}.png`]));
      },
    },
  );

  // Queue 8 parallel scenes plus 1 non-parallel scene in one synchronous turn (testing setImmediate batch formation).
  const jobs = [];
  for (let i = 1; i <= 8; i++) jobs.push(queue.add(baseParams(`scene-0${i}`, { parallel: true })));
  jobs.push(queue.add(baseParams("scene-09")));

  await waitUntil(() => jobs.every((j) => j.status === "done" || j.status === "failed"));

  // Batch 1 on main takes up to 6 (scenes 1..6); acc2 takes scenes 7..8 in parallel; scene 9 runs alone.
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].stems, ["scene-01", "scene-02", "scene-03", "scene-04", "scene-05", "scene-06"]);
  assert.deepEqual(batches[1].stems, ["scene-07", "scene-08"]);
  assert.equal(new Set(batches.map((b) => b.account)).size, 2);
  assert.equal(singles.length, 1);
  assert.match(singles[0], /^scene-09@/);

  // Per-job failure inside a batch does not fail sibling scenes.
  assert.equal(jobs[2].status, "failed");
  assert.match(jobs[2].error ?? "", /scene 3 failed/);
  assert.equal(jobs[0].status, "done");
  assert.equal(jobs[7].status, "done");
});

test("JobQueue runs flow and music lanes concurrently on one account while keeping each lane serial", async () => {
  let activeTotal = 0;
  let maxTotal = 0;
  const activePerLane = { flow: 0, music: 0 };
  const maxPerLane = { flow: 0, music: 0 };
  const seenLanes = [];

  const queue = new JobQueue(
    async (job, _account, lane) => {
      seenLanes.push(`${job.params.file_stem}:${lane}`);
      activeTotal++;
      maxTotal = Math.max(maxTotal, activeTotal);
      activePerLane[lane]++;
      maxPerLane[lane] = Math.max(maxPerLane[lane], activePerLane[lane]);
      await sleep(40);
      activePerLane[lane]--;
      activeTotal--;
      return [`${job.params.file_stem}.out`];
    },
    {
      accounts: () => ["main"],
      ready: async () => undefined,
      pauseMinMs: 0,
      pauseMaxMs: 0,
    },
  );

  const f1 = queue.add(baseParams("scene-01"));
  const f2 = queue.add(baseParams("scene-02"));
  const m1 = queue.add(baseParams("song-01", { lane: "music" }));
  const m2 = queue.add(baseParams("song-02", { lane: "music" }));

  await waitUntil(() => [f1, f2, m1, m2].every((j) => j.status === "done"));

  assert.equal(maxTotal, 2, "expected flow and music lanes to overlap on the same account");
  assert.equal(maxPerLane.flow, 1, "flow lane must stay strictly serial");
  assert.equal(maxPerLane.music, 1, "music lane must stay strictly serial");
  assert.ok(seenLanes.indexOf("scene-01:flow") < seenLanes.indexOf("scene-02:flow"));
  assert.ok(seenLanes.indexOf("song-01:music") < seenLanes.indexOf("song-02:music"));
});

test("JobQueue isolates lane readiness, unusual activity, and busy flags across flow and music lanes", async () => {
  let releaseMusic;
  const musicGate = new Promise((r) => (releaseMusic = r));
  let musicStarted = false;
  let busyDuringMusic = false;
  let flowBusyDuringMusic = true;
  let musicBusyDuringMusic = false;

  const queue = new JobQueue(
    async (job, _account, lane) => {
      if (lane === "music") {
        musicStarted = true;
        busyDuringMusic = queue.busy;
        flowBusyDuringMusic = queue.busyOn("main", "flow");
        musicBusyDuringMusic = queue.busyOn("main", "music");
        await musicGate;
        return ["song.mp3"];
      }
      if (job.params.file_stem === "unusual") {
        throw new Error('We noticed some unusual activity on Flow.');
      }
      return [`${job.params.file_stem}.png`];
    },
    {
      accounts: () => ["main"],
      // Music is ready while flow is NOT ready on acc2 (here single account: test cross-lane isolation below).
      ready: async (_account, lane) => (lane === "flow" ? undefined : undefined),
      pauseMinMs: 0,
      pauseMaxMs: 0,
    },
  );

  // 1. Shutdown busy stays true while ONLY a music job is running, while flow busyOn is false.
  const song = queue.add(baseParams("song-01", { lane: "music" }));
  await waitUntil(() => musicStarted);
  assert.equal(busyDuringMusic, true, "queue.busy must be true while only a music job runs");
  assert.equal(flowBusyDuringMusic, false, "busyOn(main, flow) must be false when only music is running");
  assert.equal(musicBusyDuringMusic, true, "busyOn(main, music) must be true when music is running");

  // 2. Unusual activity on flow stops queued flow jobs only, never queued music jobs.
  const queuedSong = queue.add(baseParams("song-02", { lane: "music" }));
  const badFlow = queue.add(baseParams("unusual"));
  const queuedFlow = queue.add(baseParams("after-unusual"));
  await waitUntil(() => badFlow.status === "failed" && queuedFlow.status === "failed");
  assert.equal(queuedSong.status, "queued", "unusual activity on flow must not fail queued music jobs");

  releaseMusic();
  await waitUntil(() => song.status === "done" && queuedSong.status === "done");
  assert.equal(song.status, "done");
  assert.equal(queuedSong.status, "done");
});

test("JobQueue not-ready music lane does not block flow jobs and not-ready flow lane does not block music jobs", async () => {
  const ran = [];
  const queue = new JobQueue(
    async (job, account, lane) => {
      ran.push(`${job.params.file_stem}@${account}:${lane}`);
      return [`${job.params.file_stem}.out`];
    },
    {
      accounts: () => ["main", "acc2"],
      // main is not ready for music; acc2 is not ready for flow.
      ready: async (account, lane) => {
        if (account === "main" && lane === "music") return "main music signed out";
        if (account === "acc2" && lane === "flow") return "acc2 flow signed out";
        return undefined;
      },
      pauseMinMs: 0,
      pauseMaxMs: 0,
    },
  );

  const flowJob = queue.add(baseParams("scene-01"));
  const musicJob = queue.add(baseParams("song-01", { lane: "music" }));
  await waitUntil(() => flowJob.status === "done" && musicJob.status === "done");

  assert.equal(flowJob.account, "main", "main should take flow even though main music is not ready");
  assert.equal(musicJob.account, "acc2", "acc2 should take music even though acc2 flow is not ready");
  assert.equal(queue.workerView("main", "flow").not_ready, undefined);
  assert.equal(queue.workerView("main", "music").not_ready, "main music signed out");
  assert.equal(queue.workerView("acc2", "flow").not_ready, "acc2 flow signed out");
  assert.equal(queue.workerView("acc2", "music").not_ready, undefined);
});

test("JobQueue keeps single-account flow-only pausedReason wording unchanged", async () => {
  let seenPacing = null;
  const queue = new JobQueue(
    async (job) => [`${job.params.file_stem}.png`],
    {
      accounts: () => ["main"],
      ready: async () => undefined,
      pauseMinMs: 120,
      pauseMaxMs: 120,
    },
  );

  const j1 = queue.add(baseParams("scene-01"));
  const j2 = queue.add(baseParams("scene-02"));
  await waitUntil(() => {
    if (queue.pausedReason) {
      seenPacing = queue.pausedReason;
      return true;
    }
    return j2.status === "done";
  });
  await waitUntil(() => j1.status === "done" && j2.status === "done");
  assert.match(seenPacing ?? "", /^pacing: next generation in \d+s$/);
});

test("JobQueue failQueuedLane stops remaining queued music jobs without disturbing flow jobs", async () => {
  let releaseFirst;
  const firstGate = new Promise((r) => (releaseFirst = r));
  let firstStarted = false;

  const queue = new JobQueue(
    async (job, _account, lane) => {
      if (job.params.file_stem === "song-01") {
        firstStarted = true;
        await firstGate;
        // Simulate a song that cost more than max_credits: fail remaining queued music jobs and finish this one.
        queue.failQueuedLane("music", "a song cost more than its limit; nothing more was started");
        return ["song-01.m4a"];
      }
      return [`${job.params.file_stem}.${lane === "music" ? "m4a" : "png"}`];
    },
    {
      accounts: () => ["main"],
      ready: async () => undefined,
      pauseMinMs: 0,
      pauseMaxMs: 0,
    },
  );

  const s1 = queue.add(baseParams("song-01", { type: "audio", lane: "music", max_credits: 5 }));
  const s2 = queue.add(baseParams("song-02", { type: "audio", lane: "music", max_credits: 5 }));
  const s3 = queue.add(baseParams("song-03", { type: "audio", lane: "music", max_credits: 5 }));
  const f1 = queue.add(baseParams("scene-01"));

  await waitUntil(() => firstStarted);
  releaseFirst();
  await waitUntil(() => [s1, s2, s3, f1].every((j) => j.status === "done" || j.status === "failed"));

  assert.equal(s1.status, "done");
  assert.equal(s2.status, "failed");
  assert.equal(s2.error, "a song cost more than its limit; nothing more was started");
  assert.equal(s3.status, "failed");
  assert.equal(s3.error, "a song cost more than its limit; nothing more was started");
  assert.equal(f1.status, "done");
});
