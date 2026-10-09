#!/usr/bin/env node
// flow-studio start | stop | status: runs the Flow Studio panel in the background instead of in a terminal window
// that has to stay open.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listAccounts } from "./accounts.js";
import { closeAllOwnChromes, ownChrome, PROFILE_DIR } from "./chrome.js";
import {
  CONFIG,
  CONFIG_FILE,
  HOME_DIR,
  LOG_DIR,
  LOG_FILE,
  TOKEN_FILE,
  clearState,
  ensureConfig,
  health,
  pidAlive,
  readConfig,
  readState,
  rotateLogIfNeeded,
  type Health,
  type OwnerKind,
} from "./config.js";
import { openUrl } from "./platform.js";

const STUDIO_JS = fileURLToPath(new URL("./studio.js", import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WHO: Record<OwnerKind, string> = {
  daemon: "in the background",
  studio: "in a terminal window (npm run studio)",
  mcp: "by your AI assistant",
};

interface Owner {
  port: number;
  url: string;
  pid?: number;
  kind?: OwnerKind;
  started?: string;
  busy: boolean;
}

// The flow-mcp process serving the panel for this folder, confirmed by asking it. The note on disk only says where to
// look: a process is the owner only if the one answering on that port reports name "flow-mcp" and the same process id.
async function findOwner(): Promise<Owner | null> {
  const state = readState();
  if (state) {
    const answer = await health(state.port);
    if (answer?.name === "flow-mcp" && answer.pid === state.pid) {
      return { port: state.port, url: `http://127.0.0.1:${state.port}`, pid: state.pid, kind: answer.kind, started: state.started, busy: Boolean(answer.busy) };
    }
  }
  // An older flow-mcp leaves no note, and answers on the usual port.
  const answer: Health | null = await health(CONFIG.port);
  if (answer?.name !== "flow-mcp") return null;
  return { port: CONFIG.port, url: `http://127.0.0.1:${CONFIG.port}`, pid: answer.pid, kind: answer.kind, busy: Boolean(answer.busy) };
}

const describe = (o: Owner) => `${o.kind ? WHO[o.kind] : "by another flow-mcp"}${o.pid ? `, process ${o.pid}` : ""}`;

async function start(): Promise<number> {
  if (ensureConfig()) console.log(`Settings file created: ${CONFIG_FILE}`);
  const already = await findOwner();
  if (already) {
    console.log(`Flow Studio is already running at ${already.url} (${describe(already)}).`);
    if (flag("open")) openUrl(already.url);
    return 0;
  }
  mkdirSync(LOG_DIR, { recursive: true });
  rotateLogIfNeeded(LOG_FILE);
  const log = openSync(LOG_FILE, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [STUDIO_JS, "--daemon"], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  } finally {
    // Always close the inherited log descriptor in the parent so it is not leaked.
    closeSync(log);
  }
  let exited: number | null | undefined;
  child.once("exit", (code) => (exited = code));
  child.unref();

  // The server can spend up to about 40 seconds working out who holds a port that does not answer.
  for (let i = 0; i < 180 && exited === undefined; i++) {
    await sleep(250);
    const state = readState();
    if (state && state.pid === child.pid && (await health(state.port, 1500))?.pid === child.pid) {
      const url = `http://127.0.0.1:${state.port}`;
      console.log(`Flow Studio is running in the background at ${url} (process ${child.pid}).`);
      if (state.port !== CONFIG.port) console.log(`Port ${CONFIG.port} is used by another program, so it is on ${state.port} instead.`);
      console.log(`Stop it with: flow-studio stop`);
      if (flag("open")) openUrl(url);
      return 0;
    }
  }
  const owner = await findOwner();
  if (owner) {
    console.log(`Flow Studio is already running at ${owner.url} (${describe(owner)}).`);
    return 0;
  }
  console.error(`Flow Studio did not start. The log is at ${LOG_FILE}`);
  if (existsSync(LOG_FILE)) console.error(readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-5).join("\n"));
  if (exited === undefined && child.pid) {
    try {
      process.kill(child.pid);
    } catch {
      // Already exited.
    }
  }
  return 1;
}

async function stop(): Promise<number> {
  const owner = await findOwner();
  if (owner && owner.kind !== "daemon" && owner.kind !== "studio") {
    console.error(
      owner.kind === "mcp"
        ? `Flow Studio at ${owner.url} is being run by your AI assistant (process ${owner.pid}), not by flow-studio start. Nothing was stopped: quit the assistant to stop it.`
        : `Flow Studio at ${owner.url} is being run by another flow-mcp that flow-studio did not start. Nothing was stopped.`,
    );
    return 1;
  }
  const force = flag("force");
  if (owner?.busy && !force) {
    console.error(`Flow Studio is in the middle of making something. Nothing was stopped: wait for it to finish, or use flow-studio stop --force.`);
    return 1;
  }
  if (!owner) console.log("Flow Studio is not running.");
  else {
    const pid = owner.pid;
    if (!pid) {
      console.error(`Flow Studio at ${owner.url} did not report its process id, so it could not be verified. Nothing was stopped.`);
      return 1;
    }
    // Ask it to finish by itself first, passing the force flag so the server itself enforces the busy guard.
    const res = await fetch(`${owner.url}/api/shutdown`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flow-token": existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "",
      },
      body: JSON.stringify({ force }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);

    let interrupted: { id: string; scene: string; account?: string }[] = [];
    if (res) {
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        running_jobs?: { id: string; scene: string; account?: string }[];
        interrupted_jobs?: { id: string; scene: string; account?: string }[];
      };
      if (res.status === 409) {
        const list = (data.running_jobs ?? []).map((j) => `${j.id} (${j.scene}${j.account ? `, ${j.account}` : ""})`).join(", ");
        console.error(`${data.error ?? "Flow Studio is busy."}${list ? ` Running: ${list}.` : ""}`);
        return 1;
      }
      if (!res.ok) {
        console.error(data.error ?? `Flow Studio refused to stop (HTTP ${res.status}).`);
        return 1;
      }
      interrupted = data.interrupted_jobs ?? [];
    }

    const gone = async (ms: number) => {
      for (let waited = 0; waited < ms && pidAlive(pid); waited += 200) await sleep(200);
      return !pidAlive(pid);
    };
    if (!(await gone(8000))) {
      // It did not exit. Ending the process directly is the last resort, and ONLY after re-confirming via health
      // that this pid still belongs to flow-mcp (never signal a bare pid from a stale file).
      const check = await health(owner.port);
      if (check?.name !== "flow-mcp" || check.pid !== pid) {
        console.error(`Process ${pid} stopped answering and can no longer be confirmed to be Flow Studio. Nothing was ended.`);
        return 1;
      }
      process.kill(pid);
      if (!(await gone(5000))) {
        console.error(`Flow Studio (process ${pid}) did not stop.`);
        return 1;
      }
    }
    clearState(pid);
    console.log(`Flow Studio stopped (process ${pid}).`);
    if (interrupted.length) {
      const list = interrupted.map((j) => `${j.id} (${j.scene}${j.account ? `, ${j.account}` : ""})`).join(", ");
      console.log(`Interrupted running job(s): ${list}`);
    }
  }
  if (!flag("keep-chrome")) {
    const closed = await closeAllOwnChromes();
    if (closed.length) {
      console.log(
        closed.length === 1
          ? "Flow Studio's Chrome window closed. Your sign-in is kept for next time."
          : `Closed Flow Studio's Chrome windows for: ${closed.join(", ")}. Your sign-ins are kept for next time.`,
      );
    }
  }
  return 0;
}

async function status(): Promise<number> {
  const owner = await findOwner();
  const accounts = listAccounts();
  const chromes = await Promise.all(accounts.map(async (a) => ({ name: a.name, port: await ownChrome(a) })));
  const mainChrome = chromes[0]?.port ?? null;
  const { problems } = readConfig();
  if (flag("json")) {
    console.log(
      JSON.stringify(
        {
          running: Boolean(owner),
          url: owner?.url ?? null,
          pid: owner?.pid ?? null,
          started_by: owner?.kind ?? null,
          busy: owner?.busy ?? false,
          chrome: { open: Boolean(mainChrome), port: mainChrome },
          ...(chromes.length > 1 ? { accounts: chromes.map((c) => ({ name: c.name, chrome_open: Boolean(c.port), chrome_port: c.port })) } : {}),
          folder: HOME_DIR,
          config: { file: CONFIG_FILE, exists: existsSync(CONFIG_FILE), problems, port: CONFIG.port, cdpPort: CONFIG.cdpPort, output: CONFIG.output },
          log: LOG_FILE,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const row = (label: string, value: string) => console.log(`${label.padEnd(16)}${value}`);
  if (owner) {
    row("Flow Studio", `running at ${owner.url}`);
    row("Started", `${describe(owner)}${owner.started ? `, since ${owner.started}` : ""}`);
    if (owner.busy) row("Working", "making something right now");
  } else row("Flow Studio", "not running (start it with: flow-studio start)");
  if (chromes.length === 1) row("Flow Chrome", mainChrome ? `open, controlled on port ${mainChrome}` : "closed");
  else {
    const openList = chromes.filter((c) => c.port).map((c) => `${c.name} (port ${c.port})`);
    row("Flow Chrome", openList.length ? `open: ${openList.join(", ")}` : "closed");
  }
  row("Folder", `${HOME_DIR}${existsSync(HOME_DIR) ? "" : " (not created yet)"}`);
  row("Settings", `${CONFIG_FILE}${existsSync(CONFIG_FILE) ? "" : " (not created yet; using the defaults)"}`);
  row("Ports", `panel ${CONFIG.port}, Chrome ${CONFIG.cdpPort} (the next free one is used if either is taken)`);
  row("Chrome profile", PROFILE_DIR);
  row("Output", CONFIG.output);
  row("Log", LOG_FILE);
  for (const p of problems) row("Problem", p);
  return 0;
}

const HELP = `Usage: flow-studio <command>

  start    Run the Flow Studio panel in the background.   --open  also open it in the browser
  stop     Stop it, and close Flow Studio's Chrome window. --force even while it is making something
                                                           --keep-chrome leave the Chrome window open
  status   Show whether it is running, where, and which folders it uses.   --json`;

try {
  if (command === "start") process.exit(await start());
  else if (command === "stop") process.exit(await stop());
  else if (command === "status") process.exit(await status());
  else {
    console.log(HELP);
    process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
