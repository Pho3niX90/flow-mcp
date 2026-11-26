import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { claimState, clearState, DEFAULTS, ensureConfig, health, pidAlive, readConfig, readState, rotateLogIfNeeded } from "../dist/config.js";
import { startServer } from "../dist/server.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI_JS = join(ROOT, "dist", "cli.js");
const TMP_BASE = process.env.FLOW_MCP_TMP || tmpdir();

function tempDir(prefix) {
  mkdirSync(TMP_BASE, { recursive: true });
  return mkdtempSync(join(TMP_BASE, prefix));
}

function getFreePortPair() {
  return new Promise((resolvePort, reject) => {
    const s1 = createNetServer();
    s1.once("error", reject);
    s1.listen(0, "127.0.0.1", () => {
      const addr = s1.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const s2 = createNetServer();
      s2.once("error", () => {
        s1.close(() => resolvePort(getFreePortPair()));
      });
      s2.listen(port + 1, "127.0.0.1", () => {
        s2.close(() => s1.close(() => resolvePort(port)));
      });
    });
  });
}

function runCli(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, out, err }));
  });
}

test("readConfig applies defaults, validates fields, and tolerates corrupt JSON", () => {
  const dir = tempDir("flow-cfg-");
  try {
    const file = join(dir, "config.json");
    const missing = readConfig(file);
    assert.deepEqual(missing.config, DEFAULTS);
    assert.deepEqual(missing.problems, []);

    assert.equal(ensureConfig(file), true);
    assert.equal(ensureConfig(file), false);
    const created = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(created.port, DEFAULTS.port);
    assert.equal(created.cdpPort, DEFAULTS.cdpPort);

    writeFileSync(file, JSON.stringify({ port: 9999, cdpPort: 9444, output: "/tmp/out", chrome: "/bin/chrome" }));
    const valid = readConfig(file);
    assert.equal(valid.problems.length, 0);
    assert.equal(valid.config.port, 9999);
    assert.equal(valid.config.cdpPort, 9444);
    assert.equal(valid.config.output, "/tmp/out");
    assert.equal(valid.config.chrome, "/bin/chrome");

    writeFileSync(file, JSON.stringify({ port: 80, cdpPort: "bad", output: 123 }));
    const invalid = readConfig(file);
    assert.equal(invalid.problems.length, 3);
    assert.equal(invalid.config.port, DEFAULTS.port);
    assert.equal(invalid.config.cdpPort, DEFAULTS.cdpPort);
    assert.equal(invalid.config.output, DEFAULTS.output);

    writeFileSync(file, "{not valid json");
    const corrupt = readConfig(file);
    assert.equal(corrupt.problems.length, 1);
    assert.deepEqual(corrupt.config, DEFAULTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimState, readState, and clearState enforce single ownership and ignore dead pids", () => {
  const dir = tempDir("flow-state-");
  try {
    const stateFile = join(dir, "studio.json");
    const mine = { pid: process.pid, port: 8787, kind: "daemon", started: new Date().toISOString() };
    assert.equal(claimState(mine, stateFile), null);
    assert.equal(readState(stateFile)?.pid, process.pid);

    // Clear with a mismatched pid leaves the note intact.
    clearState(process.pid + 99999, stateFile);
    assert.equal(existsSync(stateFile), true);

    // Clear with the owning pid removes it.
    clearState(process.pid, stateFile);
    assert.equal(existsSync(stateFile), false);

    // A stale file naming a nonexistent pid is ignored and replaced cleanly.
    writeFileSync(stateFile, JSON.stringify({ pid: 99999999, port: 8787, kind: "daemon", started: "2020-01-01T00:00:00Z" }));
    assert.equal(readState(stateFile), null);
    assert.equal(claimState(mine, stateFile), null);
    assert.equal(readState(stateFile)?.pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateLogIfNeeded keeps small logs intact and rotates oversized logs to .1", () => {
  const dir = tempDir("flow-log-");
  try {
    const log = join(dir, "studio.log");
    const prev = `${log}.1`;
    assert.equal(rotateLogIfNeeded(log, 100), false);

    writeFileSync(log, "small\n");
    assert.equal(rotateLogIfNeeded(log, 100), false);
    assert.equal(existsSync(prev), false);

    writeFileSync(log, "x".repeat(120));
    assert.equal(rotateLogIfNeeded(log, 100), true);
    assert.equal(existsSync(log), false);
    assert.equal(readFileSync(prev, "utf8").length, 120);

    writeFileSync(log, "y".repeat(150));
    assert.equal(rotateLogIfNeeded(log, 100), true);
    assert.equal(readFileSync(prev, "utf8").length, 150);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startServer handles health, shutdown busy/force/403/401 guards, and free-port fallback", async () => {
  const dir = tempDir("flow-srv-");
  const basePort = await getFreePortPair();
  const dummy = createHttpServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><body>other app</body></html>");
  });
  await new Promise((r) => dummy.listen(basePort, "127.0.0.1", r));

  const stateFile = join(dir, "studio.json");
  const tokenFile = join(dir, "token");
  const uploadDir = join(dir, "uploads");
  let shutdownCalled = false;

  const running = [{ id: "job-1", scene: "01-opening", account: "main" }];
  const fakeCore = {
    get busy() {
      return running.length > 0;
    },
    runningJobs: () => running.slice(),
  };

  try {
    const role = await startServer(fakeCore, "daemon", {
      port: basePort,
      stateFile,
      tokenFile,
      uploadDir,
      probeAttempts: 2,
      probeDelayMs: 50,
      onShutdown: () => {
        shutdownCalled = true;
      },
    });
    assert.equal(role, "owner");

    const state = readState(stateFile);
    assert.ok(state, "studio.json should be written");
    assert.equal(state.port, basePort + 1, "should fall back to next free port when another program holds the configured port");

    const h = await health(state.port);
    assert.equal(h?.name, "flow-mcp");
    assert.equal(h?.pid, process.pid);
    assert.equal(h?.kind, "daemon");
    assert.equal(h?.busy, true);
    assert.equal(h?.running_jobs, 1);

    const token = readFileSync(tokenFile, "utf8").trim();

    // Missing token -> 401
    const unauth = await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, { method: "POST" });
    assert.equal(unauth.status, 401);

    // Busy without force -> 409 listing running_jobs
    const busyRes = await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flow-token": token },
      body: JSON.stringify({ force: false }),
    });
    assert.equal(busyRes.status, 409);
    const busyBody = await busyRes.json();
    assert.equal(busyBody.busy, true);
    assert.equal(busyBody.running_jobs.length, 1);
    assert.equal(busyBody.running_jobs[0].id, "job-1");
    assert.equal(shutdownCalled, false);

    // Busy with force -> 200 with interrupted_jobs and closes server
    const forceRes = await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flow-token": token },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(forceRes.status, 200);
    const forceBody = await forceRes.json();
    assert.equal(forceBody.stopping, true);
    assert.equal(forceBody.interrupted_jobs.length, 1);

    for (let i = 0; i < 40 && !shutdownCalled; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(shutdownCalled, true);
    assert.equal(existsSync(stateFile), false);

    // MCP-owned server refuses /api/shutdown with 403 even with valid token + force.
    let mcpClosed = false;
    let mcpServer = null;
    const mcpPort = await getFreePortPair();
    const mcpState = join(dir, "mcp-studio.json");
    const mcpTokenFile = join(dir, "mcp-token");
    try {
      const mcpRole = await startServer(
        { busy: false, runningJobs: () => [] },
        "mcp",
        {
          port: mcpPort,
          stateFile: mcpState,
          tokenFile: mcpTokenFile,
          uploadDir,
          probeAttempts: 2,
          probeDelayMs: 50,
          onShutdown: () => {
            mcpClosed = true;
          },
          onServer: (srv) => {
            mcpServer = srv;
          },
        },
      );
      assert.equal(mcpRole, "owner");
      // A second startServer pointing at the same studio.json steps back as a client.
      const clientRole = await startServer(
        { busy: false, runningJobs: () => [] },
        "studio",
        {
          port: mcpPort,
          stateFile: mcpState,
          tokenFile: mcpTokenFile,
          uploadDir,
          probeAttempts: 2,
          probeDelayMs: 50,
        },
      );
      assert.equal(clientRole, "client");

      const mcpToken = readFileSync(mcpTokenFile, "utf8").trim();
      const refused = await fetch(`http://127.0.0.1:${mcpPort}/api/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-flow-token": mcpToken },
        body: JSON.stringify({ force: true }),
      });
      assert.equal(refused.status, 403);
      assert.equal(mcpClosed, false);
    } finally {
      clearState(process.pid, mcpState);
      if (mcpServer) await new Promise((r) => mcpServer.close(r));
    }
  } finally {
    await new Promise((r) => dummy.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flow-studio CLI start, status, idempotent start, and stop work cleanly without launching Chrome", async () => {
  const rootTmp = tempDir("flow-cli-");
  const home = join(rootTmp, "home");
  const outDir = join(rootTmp, "out");
  const port = await getFreePortPair();
  const cdpPort = await getFreePortPair();
  const env = {
    ...process.env,
    FLOW_MCP_HOME: home,
    FLOW_MCP_PORT: String(port),
    FLOW_MCP_CDP_PORT: String(cdpPort),
    FLOW_MCP_OUTPUT: outDir,
  };

  let startedPid = null;
  try {
    // 1. status on a fresh folder does not create it.
    const st0 = await runCli(["status", "--json"], env);
    assert.equal(st0.code, 0, st0.err);
    const s0 = JSON.parse(st0.out);
    assert.equal(s0.running, false);
    assert.equal(s0.chrome.open, false);
    assert.equal(existsSync(home), false);

    // 2. start launches background daemon and creates config.json.
    const started = await runCli(["start"], env);
    assert.equal(started.code, 0, `${started.out}\n${started.err}`);
    assert.match(started.out, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
    assert.equal(existsSync(join(home, "config.json")), true);

    const st1 = await runCli(["status", "--json"], env);
    assert.equal(st1.code, 0, st1.err);
    const s1 = JSON.parse(st1.out);
    assert.equal(s1.running, true);
    assert.equal(s1.started_by, "daemon");
    assert.equal(s1.url, `http://127.0.0.1:${port}`);
    assert.equal(s1.chrome.open, false);
    startedPid = s1.pid;
    assert.ok(Number.isInteger(startedPid) && pidAlive(startedPid));

    // 3. second start is idempotent.
    const second = await runCli(["start"], env);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /already running/i);
    assert.equal((await health(port))?.pid, startedPid);

    // 4. stop ends the daemon and cleans studio.json.
    const stopped = await runCli(["stop"], env);
    assert.equal(stopped.code, 0, `${stopped.out}\n${stopped.err}`);
    assert.equal(pidAlive(startedPid), false);
    assert.equal(existsSync(join(home, "studio.json")), false);
    startedPid = null;

    // 5. stop when not running is harmless.
    const stopAgain = await runCli(["stop"], env);
    assert.equal(stopAgain.code, 0, stopAgain.err);
    assert.match(stopAgain.out, /not running/i);
  } finally {
    if (startedPid && pidAlive(startedPid)) {
      try {
        process.kill(startedPid);
      } catch {
        // Already exited.
      }
    }
    rmSync(rootTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
