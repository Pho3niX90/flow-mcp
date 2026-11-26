import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Lane = "flow" | "music";

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  // Which site lane drives this job: "flow" (default) or "music". Different lanes on the same account run in parallel.
  lane?: Lane;
  duration?: number;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  first_frame_at?: number;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  // Cutouts: this job redraws the white take of job <matte_from> on black, then both become one transparent PNG.
  matte_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  // The scene number each agent scene is saved as. A retry of scenes 7 and 12 keeps scene-07 and scene-12; without it
  // the numbers run on from file_stem.
  agent_numbers?: number[];
  // Reference images for an agent batch: attached once as ingredients in the agent composer (absolute paths, uploaded
  // once, or "asset:<title>"), with a short name each, plus which of them every scene uses (names, per scene).
  agent_refs?: { image: string; name: string }[];
  agent_scene_refs?: string[][];
  // Flow asset names of agent_refs after upload, so a retry round re-attaches without uploading again.
  agent_ref_assets?: string[];
  // The account whose project holds those uploads.
  agent_ref_account?: string;
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  // Image scene sent with the queued ones after it without waiting for each to finish (flow_generate parallel_images).
  parallel?: boolean;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
  // Run on this account only. Unset: whichever enabled account is free first.
  account?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  // Scene numbers a batch still could not make after all its own retries; flow_retry redoes just these.
  failed_scenes?: number[];
  // The account that took the job, set when it starts.
  account?: string;
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job, account: string, lane: Lane) => Promise<string[]>;
// Sends several image scenes one after another without waiting for each, then collects them; one result per job.
export type BatchRunner = (jobs: Job[], account: string, lane: Lane) => Promise<(string[] | Error)[]>;

export interface QueueHooks {
  // The accounts that may take work, in order of preference.
  accounts: () => string[];
  // undefined when the account can generate on this lane now, otherwise what the user must do first (sign in, open a project).
  ready: (account: string, lane: Lane) => Promise<string | undefined>;
  // Optional batch runner for queued parallel image scenes on one account.
  batchRunner?: BatchRunner;
  // Optional overrides for pacing in unit tests.
  pauseMinMs?: number;
  pauseMaxMs?: number;
  musicPauseMinMs?: number;
  musicPauseMaxMs?: number;
}

// Flow is driven like a careful person would: one generation at a time PER (ACCOUNT, LANE), with a randomised pause
// between them. Several accounts are several people, each at their own Chrome, and each site (Flow / Flow Music) has
// its own window and lane so a song never waits behind a video.
// Image scenes marked parallel go out together inside one account's flow worker (the pause between sends lives in the
// driver), and the pause below comes before the next batch.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;
const MUSIC_PAUSE_MIN_MS = Number(process.env.FLOW_MCP_MUSIC_PAUSE_MIN_S ?? process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const MUSIC_PAUSE_MAX_MS = Number(process.env.FLOW_MCP_MUSIC_PAUSE_MAX_S ?? process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;
// A batch counts on its new tiles staying in the part of the grid Flow keeps mounted at the top (30+ tiles seen).
const BATCH_MAX = 6;
// An account found not ready (signed out, no project open) is left alone this long before it is checked again.
const RECHECK_MS = 60_000;

interface Worker {
  account: string;
  lane: Lane;
  working: boolean;
  lastFinished: number;
  pausedReason: string | null;
  notReady?: { hint: string; at: number };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const laneOf = (job: Job): Lane => job.params.lane ?? "flow";
const workerKey = (account: string, lane: Lane) => `${account.toLowerCase()}:${lane}`;

export class JobQueue {
  private jobs = new Map<string, Job>();
  private workers = new Map<string, Worker>();
  // Jobs a worker has taken but not started yet (it is still in its pause): no other worker may take them.
  private claimed = new Set<string>();

  constructor(
    private runner: JobRunner,
    private hooks: QueueHooks,
  ) {}

  private worker(account: string, lane: Lane): Worker | undefined {
    return this.workers.get(workerKey(account, lane));
  }

  add(params: SceneParams): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: "queued",
      params,
      files: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    // Started on the next turn of the event loop, once the caller has queued the rest of its scenes: started at once,
    // the first scene ran alone and a parallel batch never formed (2026-10-23).
    setImmediate(() => this.kick());
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  // Whether this account's window for `lane` is in the middle of a job: direct calls on that site must wait for it.
  busyOn(account: string, lane: Lane = "flow"): boolean {
    return this.list().some((j) => j.status === "running" && j.account !== undefined && same(j.account, account) && laneOf(j) === lane);
  }

  get pausedReason(): string | null {
    const severalAccounts = this.hooks.accounts().length > 1;
    const allWorkers = [...this.workers.values()];
    const hasOtherLane = allWorkers.some((w) => w.lane !== "flow" && (w.working || w.pausedReason));
    const waits = allWorkers
      .filter((w) => w.pausedReason)
      .map((w) => {
        const prefix = [severalAccounts ? w.account : "", hasOtherLane ? w.lane : ""].filter(Boolean).join("/");
        return prefix ? `${prefix}: ${w.pausedReason}` : w.pausedReason!;
      });
    return waits.length ? waits.join(" · ") : null;
  }

  // What one account is doing on a lane, for flow_status and flow_accounts.
  workerView(account: string, lane: Lane = "flow"): { busy: boolean; pacing: string | null; not_ready?: string } {
    const w = this.worker(account, lane);
    return { busy: this.busyOn(account, lane), pacing: w?.pausedReason ?? null, ...(w?.notReady ? { not_ready: w.notReady.hint } : {}) };
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  // Puts a failed or cancelled job back in line with the same settings and file name.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.finishedAt = undefined;
      job.account = undefined;
      this.kick();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.kick();
    }
    return job;
  }

  // Wakes a worker for every enabled account on every lane that has queued work; each stops when its lane is empty.
  kick(): void {
    const activeLanes = new Set<Lane>(this.list().filter((j) => j.status === "queued").map(laneOf));
    for (const account of this.hooks.accounts()) {
      for (const lane of activeLanes) {
        const key = workerKey(account, lane);
        let w = this.workers.get(key);
        if (!w) this.workers.set(key, (w = { account, lane, working: false, lastFinished: 0, pausedReason: null }));
        if (!w.working) void this.work(w);
      }
    }
  }

  // A job that builds on another (chain_previous, reference_previous, the black take of a cutout) waits for it: with
  // several accounts the earlier job may still be running on another one. If that one failed, this one fails with it.
  private waitingOn(job: Job): "ready" | "wait" | Job {
    const { chain_from, reference_from, matte_from } = job.params;
    for (const id of [chain_from, reference_from, matte_from]) {
      const dep = id ? this.jobs.get(id) : undefined;
      if (!dep) continue;
      if (dep.status === "failed" || dep.status === "cancelled") return dep;
      if (dep.status !== "done") return "wait";
    }
    return "ready";
  }

  // Queued jobs that can never start are failed with the reason, instead of sitting in the line forever.
  private failStuck(): void {
    const accounts = this.hooks.accounts();
    for (const job of this.list()) {
      if (job.status !== "queued" || this.claimed.has(job.id)) continue;
      const dep = this.waitingOn(job);
      const pin = job.params.account;
      let why: string | undefined;
      if (typeof dep === "object") {
        why = `It builds on job ${dep.id} (${dep.params.file_stem}), which ${dep.status === "cancelled" ? "was cancelled" : "failed"}, so it never ran. Retry that job first, then this one.`;
      } else if (pin && !accounts.some((a) => same(a, pin))) {
        why = `It is set to run on account "${pin}", which is disabled. Enable it with flow_accounts, then retry.`;
      }
      if (why) {
        job.status = "failed";
        job.error = why;
        job.finishedAt = new Date().toISOString();
      }
    }
  }

  // The next run of jobs this worker may take on its lane: up to BATCH_MAX consecutive eligible parallel image jobs
  // (flow lane only), or one single job otherwise. An account that is not ready on this lane leaves unpinned work to
  // the others - unless none is ready on this lane, when the first account takes it and fails it with the reason.
  private nextBatch(w: Worker): Job[] {
    const accounts = this.hooks.accounts();
    const anyReady = accounts.some((a) => !this.worker(a, w.lane)?.notReady);
    const takesUnpinned = !w.notReady || (!anyReady && accounts[0] === w.account);
    const eligible = this.list().filter((j) => {
      if (j.status !== "queued" || laneOf(j) !== w.lane || this.claimed.has(j.id) || this.waitingOn(j) !== "ready") return false;
      return j.params.account ? same(j.params.account, w.account) : takesUnpinned;
    });
    if (!eligible.length) return [];
    if (w.lane !== "flow" || !this.hooks.batchRunner || !eligible[0].params.parallel) return [eligible[0]];
    const end = eligible.findIndex((j) => !j.params.parallel);
    return eligible.slice(0, end < 0 ? BATCH_MAX : Math.min(end, BATCH_MAX));
  }

  private handleUnusualActivity(w: Worker, error: string): void {
    const singleAccount = this.hooks.accounts().length <= 1;
    w.notReady = { hint: error, at: Date.now() };
    for (const other of this.list().filter((j) => j.status === "queued" && laneOf(j) === w.lane)) {
      if (!singleAccount && (!other.params.account || !same(other.params.account, w.account))) continue;
      other.status = "failed";
      other.error = 'Stopped because Flow reported "unusual activity" on the job before this. Resolve it in the Flow window, then use flow_retry.';
      other.finishedAt = new Date().toISOString();
    }
  }

  private async work(w: Worker): Promise<void> {
    if (w.working) return;
    w.working = true;
    const minMs = w.lane === "music" ? (this.hooks.musicPauseMinMs ?? this.hooks.pauseMinMs ?? MUSIC_PAUSE_MIN_MS) : (this.hooks.pauseMinMs ?? PAUSE_MIN_MS);
    const maxMs = w.lane === "music" ? (this.hooks.musicPauseMaxMs ?? this.hooks.pauseMaxMs ?? MUSIC_PAUSE_MAX_MS) : (this.hooks.pauseMaxMs ?? PAUSE_MAX_MS);
    try {
      for (;;) {
        if (!this.hooks.accounts().some((a) => same(a, w.account))) return; // disabled meanwhile
        this.failStuck();
        // An account that was not ready is checked again now and then: the user may have signed it in since.
        if (w.notReady && Date.now() - w.notReady.at > RECHECK_MS) w.notReady = undefined;
        if (!w.notReady && this.list().some((j) => j.status === "queued" && laneOf(j) === w.lane && !this.claimed.has(j.id))) {
          const hint = await this.hooks.ready(w.account, w.lane).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
          if (hint) {
            w.notReady = { hint, at: Date.now() };
            this.kick(); // the other accounts take over what this one cannot do
          }
        }
        const batch = this.nextBatch(w);
        if (!batch.length) return;
        for (const j of batch) this.claimed.add(j.id);
        let live: Job[];
        try {
          if (w.lastFinished) {
            const pause = minMs + Math.random() * Math.max(0, maxMs - minMs);
            const remaining = w.lastFinished + pause - Date.now();
            if (remaining > 0) {
              w.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
              await new Promise((r) => setTimeout(r, remaining));
              w.pausedReason = null;
            }
          }
          live = batch.filter((j) => j.status === "queued");
          if (!live.length) continue; // cancelled during the pause
          for (const j of live) {
            j.status = "running";
            j.account = w.account;
            j.attempts++;
          }
        } finally {
          for (const j of batch) this.claimed.delete(j.id);
        }
        if (live.length > 1 && w.lane === "flow" && this.hooks.batchRunner) {
          // A whole-batch failure may come after some images were sent: those are in Flow (free), not lost.
          const results = await this.hooks.batchRunner(live, w.account, w.lane).catch((err: unknown) => live.map(() => (err instanceof Error ? err : new Error(String(err)))));
          let blockedError: string | undefined;
          for (const [i, j] of live.entries()) {
            const r = results[i];
            if (r instanceof Error) {
              j.error = r.message;
              j.status = "failed";
              if (j.error.includes("unusual activity")) blockedError ??= j.error;
            } else {
              j.files = r;
              j.error = undefined;
              j.status = "done";
            }
            j.finishedAt = new Date().toISOString();
          }
          if (blockedError) this.handleUnusualActivity(w, blockedError);
          w.lastFinished = Date.now();
          this.kick();
          continue;
        }
        const job = live[0];
        try {
          job.files = await this.runner(job, w.account, w.lane);
          job.status = "done";
          job.error = undefined;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          // Failed tiles are already retried inside Flow (its own Retry button); only an agent that produced nothing
          // is re-queued here. Timeouts are never retried automatically: they may still have spent credits.
          const retryable = /agent finished without creating/i.test(job.error);
          job.status = retryable && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
          // Flow suspects automation: do not walk through the rest of the queue into the same refusal.
          if (job.error.includes("unusual activity")) this.handleUnusualActivity(w, job.error);
        }
        job.finishedAt = new Date().toISOString();
        w.lastFinished = Date.now();
        this.kick(); // jobs that waited on this one may now be ready, on any account
      }
    } finally {
      w.working = false;
      w.pausedReason = null;
    }
  }
}
