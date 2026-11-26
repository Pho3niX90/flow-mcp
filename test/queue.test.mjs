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
