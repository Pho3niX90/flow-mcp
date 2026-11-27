import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { freePort } from "./chrome.js";
import {
  CONFIG,
  HOME_DIR,
  STATE_FILE,
  TOKEN_FILE,
  claimState,
  clearState,
  ensurePrivateDir,
  health,
  readState,
  writeState,
  type OwnerKind,
  type OwnerState,
} from "./config.js";
import { CORE_METHODS, OUTPUT_ROOT, shapes, type Core } from "./core.js";

export { TOKEN_FILE };
// The port the panel is on. It starts as the one asked for and is updated by startServer() to the one really in use:
// the next free port when the wanted one belongs to another program, or the owner's port when this process is a client.
export let PORT = CONFIG.port;
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;
const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown, extra: Record<string, string> = {}) => {
  res.writeHead(code, { ...BASE_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(data));
};

function tokensEqual(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

// Streams an upload directly to disk so large files are never buffered in RAM, enforcing the byte cap on the fly.
function streamUpload(req: IncomingMessage, dest: string, limit: number): Promise<"ok" | "too_large"> {
  return new Promise((ok, fail) => {
    const out = createWriteStream(dest, { flags: "wx", mode: 0o600 });
    let written = 0;
    let settled = false;
    const cleanupAnd = (done: () => void) => {
      const unlink = () => {
        try {
          rmSync(dest, { force: true });
        } catch {
          // Best effort cleanup.
        }
        done();
      };
      if (out.closed) unlink();
      else {
        out.once("close", unlink);
        out.destroy();
      }
    };
    const abort = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanupAnd(() => fail(err));
    };

    out.on("error", abort);
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      ok("ok");
    });

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      written += chunk.length;
      if (written > limit) {
        settled = true;
        req.pause();
        cleanupAnd(() => ok("too_large"));
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once("drain", () => {
          if (!settled) req.resume();
        });
      }
    });
    req.on("end", () => {
      if (!settled) out.end();
    });
    req.on("error", abort);
    req.on("aborted", () => abort(new Error("Upload aborted.")));
    req.on("close", () => {
      if (!settled && !req.complete) abort(new Error("Upload aborted."));
    });
  });
}

export type ParsedRange = { kind: "none" } | { kind: "ok"; start: number; end: number } | { kind: "invalid" };

// Parses a single HTTP byte range (bytes=start-end, bytes=start-, bytes=-suffix). Rejects multi-range, inverted,
// out-of-bounds, and malformed headers so callers can answer 416 cleanly.
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return { kind: "none" };
  if (size <= 0) return { kind: "invalid" };
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return { kind: "invalid" };
  const [, startStr, endStr] = m;
  if (!startStr && !endStr) return { kind: "invalid" };
  if (!startStr) {
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "invalid" };
    return { kind: "ok", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startStr);
  const end = endStr ? Math.min(Number(endStr), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    return { kind: "invalid" };
  }
  return { kind: "ok", start, end };
}

function resolveAllowedMedia(file: string, roots: string[]): string | null {
  if (!file) return null;
  let realFile: string;
  try {
    realFile = realpathSync(file);
  } catch {
    return null;
  }
  const win = process.platform === "win32";
  const candidate = win ? realFile.toLowerCase() : realFile;
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const base = win ? realRoot.toLowerCase() : realRoot;
    const prefix = base.endsWith(sep) ? base : base + sep;
    if (candidate.startsWith(prefix)) return realFile;
  }
  return null;
}

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string, mediaRoots: string[]) {
  const real = resolveAllowedMedia(file, mediaRoots);
  if (!real) return json(res, 404, { error: "Not found." });
  let size: number;
  try {
    const st = statSync(real);
    if (!st.isFile()) return json(res, 404, { error: "Not found." });
    size = st.size;
  } catch {
    return json(res, 404, { error: "Not found." });
  }
  const ext = extname(real).toLowerCase();
  if (!Object.hasOwn(MIME, ext)) return json(res, 404, { error: "Not found." });
  const type = MIME[ext];
  const parsed = parseRange(req.headers.range, size);
  if (parsed.kind === "invalid") {
    res.writeHead(416, { ...BASE_HEADERS, "cache-control": "no-store", "content-range": `bytes */${size}` });
    return res.end();
  }
  if (size === 0) {
    res.writeHead(200, { ...BASE_HEADERS, "cache-control": "no-store", "content-type": type, "accept-ranges": "bytes", "content-length": 0 });
    return res.end();
  }
  const stream = parsed.kind === "ok" ? createReadStream(real, { start: parsed.start, end: parsed.end }) : createReadStream(real);
  stream.once("open", () => {
    if (parsed.kind === "ok") {
      res.writeHead(206, {
        ...BASE_HEADERS,
        "cache-control": "no-store",
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${parsed.start}-${parsed.end}/${size}`,
        "content-length": parsed.end - parsed.start + 1,
      });
    } else {
      res.writeHead(200, {
        ...BASE_HEADERS,
        "cache-control": "no-store",
        "content-type": type,
        "accept-ranges": "bytes",
        "content-length": size,
      });
    }
    stream.pipe(res);
  });
  stream.on("error", () => {
    if (!res.headersSent) json(res, 404, { error: "Not found." });
    else res.destroy();
  });
  res.on("close", () => stream.destroy());
}

export type ServerRole = "owner" | "client" | "none";

// Who holds a port: another flow-mcp, an unrelated program, or something that never answered.
// Who has it matters enormously: becoming a second LOCAL core means two processes drive the same Flow tab with separate
// queues, which is how a shot got generated and charged twice while flow_status reported an empty queue (2026-09-20).
// Claude Desktop starts several of these at once and the owner is often still booting, or busy inside a Playwright
// call, so one 2 s health check timing out proves nothing.
async function holderOf(port: number, attempts = 8, delayMs = 1500): Promise<"flow-mcp" | "other" | "unknown"> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      const other = (await res.json().catch(() => null)) as { name?: string } | null;
      if (other?.name === "flow-mcp") return "flow-mcp";
      // A valid HTTP answer from something that is NOT us means the port belongs to an unrelated program.
      return "other";
    } catch {
      if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return "unknown";
}

type RunningJobInfo = { id: string; scene: string; account?: string };

export interface StartServerOptions {
  port?: number;
  stateFile?: string;
  tokenFile?: string;
  uploadDir?: string;
  mediaRoots?: string[];
  maxUploadBytes?: number;
  probeAttempts?: number;
  probeDelayMs?: number;
  onShutdown?: () => void;
  onServer?: (server: Server) => void;
}

// Serves the Studio panel and a JSON API on localhost. Returns "client" when another flow-mcp process already
// serves this folder (that process owns the Flow tab and the queue). When the wanted port belongs to an unrelated
// program the next free one is used instead and recorded in studio.json; "none" means no port could be had at all.
export async function startServer(core: Core, kind: OwnerKind = "mcp", opts: StartServerOptions = {}): Promise<ServerRole> {
  const stateFile = opts.stateFile ?? STATE_FILE;
  const tokenFile = opts.tokenFile ?? TOKEN_FILE;
  const uploadDir = opts.uploadDir ?? UPLOAD_DIR;
  const mediaRoots = opts.mediaRoots ?? [OUTPUT_ROOT, uploadDir, CAPTIONS_DIR];
  const maxUploadBytes = opts.maxUploadBytes ?? MAX_UPLOAD;
  const probeAttempts = opts.probeAttempts ?? 8;
  const probeDelayMs = opts.probeDelayMs ?? 1500;
  ensurePrivateDir(uploadDir);
  const token = randomBytes(24).toString("hex");
  const coreWithState = core as { busy?: boolean; runningJobs?: () => RunningJobInfo[] };
  const runningJobs = (): RunningJobInfo[] => coreWithState.runningJobs?.() ?? [];
  const busy = () => Boolean(coreWithState.busy || runningJobs().length > 0);

  // A flow-mcp that is already serving this folder is the owner, whichever port it ended up on.
  // Its process is alive, so only a clear "that port is someone else's, or nobody's" says otherwise; an owner too busy
  // to answer is still the owner.
  const serving = async (s: OwnerState | null) => {
    if (!s || s.pid === process.pid) return false;
    for (let attempt = 0; attempt < probeAttempts; attempt++) {
      const answer = await health(s.port);
      if (answer) return answer.name === "flow-mcp" && answer.pid === s.pid;
      if (await freePort(s.port, 1).then(() => true, () => false)) return false;
      if (attempt + 1 < probeAttempts) await new Promise((r) => setTimeout(r, probeDelayMs));
    }
    return true;
  };
  const running = readState(stateFile);
  if (await serving(running)) {
    PORT = running!.port;
    return "client";
  }

  let activePort = opts.port ?? CONFIG.port;
  const server = createServer(async (req, res) => {
    try {
      // The Host and Origin checks block DNS-rebinding and cross-origin browser requests; the token blocks other local pages.
      if (req.headers.host !== `127.0.0.1:${activePort}` && req.headers.host !== `localhost:${activePort}`) return json(res, 403, { error: "Bad host." });
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${activePort}` && origin !== `http://localhost:${activePort}`) {
        return json(res, 403, { error: "Bad origin." });
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { name: "flow-mcp", pid: process.pid, kind, busy: busy(), running_jobs: runningJobs().length });
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204, BASE_HEADERS).end();
      if (req.method === "GET" && url.pathname === "/") {
        const nonce = randomBytes(16).toString("base64");
        const csp = [
          "default-src 'self'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src https://fonts.gstatic.com",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'",
        ].join("; ");
        res.writeHead(200, {
          ...BASE_HEADERS,
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "content-security-policy": csp,
        });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token).replace("__FLOW_NONCE__", nonce));
      }

      const isMediaGet = req.method === "GET" && url.pathname === "/media";
      const given = req.headers["x-flow-token"] ?? (isMediaGet ? (url.searchParams.get("token") ?? undefined) : undefined);
      if (!tokensEqual(given, token)) return json(res, 401, { error: "Missing or wrong token." });

      if (isMediaGet) return sendMedia(req, res, url.searchParams.get("path") ?? "", mediaRoots);

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(uploadDir, `${randomBytes(4).toString("hex")}-${name}`);
        const status = await streamUpload(req, path, maxUploadBytes);
        if (status === "too_large") return json(res, 413, { error: "Upload too large." }, { connection: "close" });
        return json(res, 200, { path });
      }

      // `flow-studio stop` ends a panel it or the user started. One that belongs to an assistant is never stopped from
      // outside, and a running generation is refused unless `force: true` is passed.
      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        if (kind === "mcp") return json(res, 403, { error: "This Flow Studio belongs to an AI assistant. Quit the assistant to stop it." });
        const raw = (await readBody(req, 64 * 1024)).toString().trim();
        let body: { force?: unknown } = {};
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as { force?: unknown };
        }
        const active = runningJobs();
        if (busy() && body.force !== true) {
          return json(res, 409, {
            error: "A generation is running right now. Wait for it to finish, or pass force: true to stop anyway.",
            busy: true,
            running_jobs: active,
          });
        }
        json(res, 200, { stopping: true, interrupted_jobs: active });
        setTimeout(() => {
          clearState(process.pid, stateFile);
          server.close(() => {
            if (opts.onShutdown) opts.onShutdown();
            else process.exit(0);
          });
          if (!opts.onShutdown) setTimeout(() => process.exit(0), 250).unref();
        }, 50);
        return;
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && CORE_METHODS.has(method) && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[method] as (a: unknown) => Promise<unknown>)(args));
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  const listen = (port: number) =>
    new Promise<boolean>((ok) => {
      server.once("error", () => ok(false));
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        ok(true);
      });
    });

  const wanted = opts.port ?? CONFIG.port;
  for (let port = wanted; port < wanted + 20 && port <= 65535; port++) {
    activePort = port;
    PORT = port;
    if (await listen(port)) {
      const me: OwnerState = { pid: process.pid, port, kind, started: new Date().toISOString() };
      const other = claimState(me, stateFile);
      if (other) {
        // Another process claimed the folder in the same instant. If it really is serving, step back and use it.
        if (await serving(other)) {
          await new Promise((r) => server.close(r));
          activePort = other.port;
          PORT = other.port;
          return "client";
        }
        writeState(me, stateFile);
      }
      ensurePrivateDir(dirname(tokenFile));
      writeFileSync(tokenFile, token, { mode: 0o600 });
      if (process.platform !== "win32") {
        try {
          chmodSync(tokenFile, 0o600);
        } catch {
          // Best effort on filesystems without POSIX permissions.
        }
      }
      if (!opts.onShutdown) {
        // Leave no note behind saying this process is still serving. No SIGHUP handler on Windows.
        process.on("exit", () => clearState(process.pid, stateFile));
        const signals = process.platform === "win32" ? (["SIGINT", "SIGTERM"] as const) : (["SIGINT", "SIGTERM", "SIGHUP"] as const);
        for (const signal of signals) process.once(signal, () => process.exit(0));
      }
      opts.onServer?.(server);
      return "owner";
    }
    const holder = await holderOf(port, probeAttempts, probeDelayMs);
    if (holder === "flow-mcp") return "client";
    // Never confirmed, but something holds the port and it is most likely a busy sibling. Defer to it: a client whose
    // calls fail loudly is far better than a second process silently spending the user's credits.
    if (holder === "unknown") return "client";
  }
  PORT = wanted;
  return "none";
}
