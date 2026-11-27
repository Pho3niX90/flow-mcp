import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Creates a private data directory with mode 0700 on Unix (also tightening existing dirs).
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  }
}

// Everything Flow Studio keeps on this computer lives in one folder: settings, the Chrome profile, logs, and the note
// saying which process is serving the panel right now.
export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const CONFIG_FILE = join(HOME_DIR, "config.json");
export const STATE_FILE = join(HOME_DIR, "studio.json");
export const TOKEN_FILE = join(HOME_DIR, "token");
export const LOG_DIR = join(HOME_DIR, "logs");
export const LOG_FILE = join(LOG_DIR, "studio.log");
// Cap the background service log so a long-running daemon cannot fill a disk: rotate at 5 MB, keeping one backup.
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface Config {
  port: number;
  cdpPort: number;
  output: string;
  chrome?: string;
}

export const DEFAULTS: Config = { port: 8787, cdpPort: 9333, output: join(homedir(), "flow-mcp-out") };

const validPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1024 && (n as number) <= 65535;
export const validPid = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;

// config.json holds the user's own choices. A bad file never stops the tools from starting: the broken setting falls
// back to its default and the problem is reported, so `flow-studio status` can show it.
export function readConfig(configFile = CONFIG_FILE): { config: Config; problems: string[] } {
  const config = { ...DEFAULTS };
  const problems: string[] = [];
  if (!existsSync(configFile)) return { config, problems };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("it must be a JSON object");
  } catch (err) {
    return { config, problems: [`${configFile} could not be read (${err instanceof Error ? err.message : err}); using the defaults.`] };
  }
  for (const key of ["port", "cdpPort"] as const) {
    if (raw[key] === undefined) continue;
    if (validPort(raw[key])) config[key] = raw[key];
    else problems.push(`${configFile}: "${key}" must be a whole number from 1024 to 65535; using ${config[key]}.`);
  }
  for (const key of ["output", "chrome"] as const) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (typeof raw[key] === "string" && raw[key]) config[key] = raw[key];
    else problems.push(`${configFile}: "${key}" must be a folder or file path.`);
  }
  return { config, problems };
}

// Environment variables win over config.json, which wins over the defaults.
const read = readConfig();
for (const p of read.problems) console.error(`flow-mcp: ${p}`);
const envPort = (name: string) => (validPort(Number(process.env[name])) ? Number(process.env[name]) : undefined);
export const CONFIG: Config = {
  port: envPort("FLOW_MCP_PORT") ?? read.config.port,
  cdpPort: envPort("FLOW_MCP_CDP_PORT") ?? read.config.cdpPort,
  output: process.env.FLOW_MCP_OUTPUT ?? read.config.output,
  chrome: process.env.FLOW_MCP_CHROME ?? read.config.chrome,
};
export const OUTPUT_ROOT = CONFIG.output;

// Writes config.json with the defaults the first time, so there is a file to edit.
export function ensureConfig(configFile = CONFIG_FILE): boolean {
  if (existsSync(configFile)) return false;
  ensurePrivateDir(dirname(configFile));
  writeFileSync(configFile, JSON.stringify({ port: DEFAULTS.port, cdpPort: DEFAULTS.cdpPort, output: DEFAULTS.output }, null, 2) + "\n");
  return true;
}

// Rotates studio.log -> studio.log.1 once it reaches maxBytes, keeping at most one previous file.
export function rotateLogIfNeeded(logFile = LOG_FILE, maxBytes = LOG_MAX_BYTES): boolean {
  try {
    if (!existsSync(logFile)) return false;
    if (statSync(logFile).size < maxBytes) return false;
    const prev = `${logFile}.1`;
    rmSync(prev, { force: true });
    renameSync(logFile, prev);
    return true;
  } catch {
    // On Windows an open handle prevents rename while the daemon is writing; rotation runs cleanly on next start.
    return false;
  }
}

// "daemon" was started by `flow-studio start`, "studio" by `npm run studio` in a terminal, "mcp" by an AI assistant.
export type OwnerKind = "daemon" | "studio" | "mcp";
export interface OwnerState {
  pid: number;
  port: number;
  kind: OwnerKind;
  started: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The process that says it is serving the panel, or null when there is no note or its process is gone.
export function readState(stateFile = STATE_FILE): OwnerState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as OwnerState;
    return validPid(s.pid) && validPort(s.port) && pidAlive(s.pid) ? s : null;
  } catch {
    return null;
  }
}

// Claims the note for this process. Creating the file fails if another process got there first, so two that start
// together cannot both believe they are the owner. Returns the other live owner when there is one.
export function claimState(state: OwnerState, stateFile = STATE_FILE): OwnerState | null {
  ensurePrivateDir(dirname(stateFile));
  for (let attempt = 0; attempt < 3; attempt++) {
    const other = readState(stateFile);
    if (other && other.pid !== state.pid) return other;
    rmSync(stateFile, { force: true });
    try {
      writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return null;
    } catch {
      // Someone else wrote it between the check and the write; look again.
    }
  }
  return readState(stateFile);
}

export function writeState(state: OwnerState, stateFile = STATE_FILE): void {
  ensurePrivateDir(dirname(stateFile));
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

// Removes the note only if it still names the given process.
export function clearState(pid: number, stateFile = STATE_FILE): void {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as OwnerState;
    if (s.pid === pid) rmSync(stateFile, { force: true });
  } catch {
    // No note to remove.
  }
}

export interface Health {
  name?: string;
  pid?: number;
  kind?: OwnerKind;
  busy?: boolean;
  running_jobs?: number;
}

export async function health(port: number, timeoutMs = 3000): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}
