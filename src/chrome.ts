import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { chromeFile, currentAccount, downloadDir, HOME_DIR, listAccounts, profileDir, type Account } from "./accounts.js";
import { CONFIG, OUTPUT_ROOT } from "./config.js";
import { CHROME_HINT, commandLineUses, debugBrowserCommandLines, startProcessCommand } from "./platform.js";

export { HOME_DIR, OUTPUT_ROOT };
export const FLOW_URL = "https://flow.google.com/";
// Flow's buttons are found by their English names ("Start generation", "Download"...), so Flow has to show in English
// whatever language the Google account uses. `hl=en` on the address does that: `hl=es` turned every label Spanish on
// an English account (2026-10-13), the choice holds through Flow's in-app navigation, and the browser's own language
// changes nothing. It only lasts until the next full page load, so every load adds it and ensureEnglish re-checks.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
};
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
// The port asked for. The one actually in use can differ when that one was taken; ownChrome() returns the real one.
export const CDP_PORT = CONFIG.cdpPort;

const CHROME_PATHS = [
  CONFIG.chrome,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  // Linux: Google's .deb installs google-chrome-stable and keeps the real binary under /opt. Chromium comes last on
  // purpose - it drives Flow the same way, but Google's sign-in can refuse it ("this browser may not be secure"), and
  // every selector in flow.ts was mapped against real Chrome.
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/google-chrome",
  "/snap/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

// One connection per account: each account is its own Chrome, reached on its own debugging port.
const browsers = new Map<string, Browser>();
// Connecting is shared per account, so two calls arriving together never launch the same Chrome twice.
const connecting = new Map<string, Promise<Browser>>();

// Which browser answers on a port, as the path of its remote-control address (it ends in an id that is new every
// time Chrome starts). Null when nothing answers.
async function browserIdAt(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
    return webSocketDebuggerUrl ? new URL(webSocketDebuggerUrl).pathname : null;
  } catch {
    return null;
  }
}

// The remote-control port of Flow Studio's own Chrome for this account, or null when it is not running. Each account
// notes its port and browser id in its own chrome.json ("main" keeps <HOME_DIR>/chrome.json), so any unrelated Chrome
// that happens to listen on the same port is never attached to or closed.
export async function ownChrome(account: Account = currentAccount()): Promise<number | null> {
  let note: { port?: number; id?: string } = {};
  try {
    note = JSON.parse(readFileSync(chromeFile(account), "utf8"));
  } catch {
    // No note yet.
  }
  if (Number.isInteger(note.port) && note.id && (await browserIdAt(note.port!)) === note.id) return note.port!;
  // No note, or one for a Chrome that has since closed. A Chrome opened by a version from before the note existed is
  // still Flow Studio's own, and people are told to leave that window open: without this, the first run after an
  // update found the usual port taken, started a second Chrome on the next one, and that second Chrome handed over to
  // the open window and exited, so nothing ever answered and the run failed. It is taken as ours only when the system
  // says the browser on the account's port was started with this account's profile folder.
  const id = await browserIdAt(account.port);
  if (!id || !debugBrowserCommandLines().some((line) => commandLineUses(line, profileDir(account), account.port))) return null;
  noteChrome(account, account.port, id);
  return account.port;
}

function noteChrome(account: Account, port: number, id: string): void {
  const noteFile = chromeFile(account);
  mkdirSync(dirname(noteFile), { recursive: true });
  writeFileSync(noteFile, JSON.stringify({ port, id, started: new Date().toISOString() }, null, 2) + "\n");
}

// Chrome holds a lock in its profile folder while it runs: "lockfile" on Windows, the "SingletonLock" link elsewhere
// (a link to nothing, so it is looked at without being followed).
function profileInUse(profile: string): boolean {
  return ["lockfile", "SingletonLock"].some((name) => {
    try {
      lstatSync(join(profile, name));
      return true;
    } catch {
      return false;
    }
  });
}

const portFree = (port: number) =>
  new Promise<boolean>((ok) => {
    const probe = createServer();
    probe.once("error", () => ok(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => ok(true)));
  });

// The wanted port, or the next free one after it.
export async function freePort(wanted: number, tries = 20): Promise<number> {
  for (let port = wanted; port < wanted + tries && port <= 65535; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`No free port from ${wanted} to ${wanted + tries - 1}.`);
}

// Points Chrome's profile fallback download directory at the account's own download folder instead of ~/Downloads.
// Only called while Chrome for this profile is NOT running. Merges valid JSON in place and leaves an unreadable
// Preferences file untouched so an existing profile can never be corrupted.
export function seedDownloadPreferences(profile: string, dlDir: string): boolean {
  const defaultDir = join(profile, "Default");
  const prefsFile = join(defaultDir, "Preferences");
  mkdirSync(dlDir, { recursive: true });
  let prefs: Record<string, unknown> = {};
  if (existsSync(prefsFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(prefsFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      prefs = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  } else {
    mkdirSync(defaultDir, { recursive: true });
  }
  const existingDownload =
    prefs.download && typeof prefs.download === "object" && !Array.isArray(prefs.download)
      ? (prefs.download as Record<string, unknown>)
      : {};
  prefs.download = { ...existingDownload, default_directory: dlDir, prompt_for_download: false };
  try {
    writeFileSync(prefsFile, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
export function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) throw new Error(`Google Chrome not found: ${CHROME_HINT}.`);
  return chromePath;
}

// Chrome slows a window it thinks nobody can see - one covered by other windows, or in the background - to about one
// drawn frame a second. Every click and hover here first waits for the page to draw a couple of frames, so with the
// Flow window behind the editor each one took two to three seconds, and a job spent a minute on clicks alone
// (measured 2026-11-26: 3 frames in 3 s, 16 s to click one tile). These switches keep the window drawing at full speed
// wherever it is. They change nothing about how the page looks or what Google sees of the browser.
const KEEP_RENDERING = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];

async function launchChrome(a: Account): Promise<number> {
  const chromePath = chromeExecutable();
  const profile = profileDir(a);
  mkdirSync(profile, { recursive: true });
  // Chrome rewrites Preferences from memory while it runs, so the file is only touched when the profile is idle.
  if (!profileInUse(profile)) seedDownloadPreferences(profile, downloadDir(a));
  const port = await freePort(a.port);
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...KEEP_RENDERING,
    inEnglish(FLOW_URL),
  ];
  // On Windows, MCP servers and background daemons are spawned hidden (SW_HIDE), which child GUI processes inherit
  // unless started with Normal style.
  if (process.platform === "win32") {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", startProcessCommand(chromePath, args)], { stdio: "ignore", windowsHide: true });
  } else {
    const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
  // The port was free a moment ago and this Chrome was told to use it, so the browser that appears there is ours.
  for (let i = 0; i < 40; i++) {
    const id = await browserIdAt(port);
    if (id) {
      noteChrome(a, port, id);
      return port;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Chrome for account "${a.name}" started but could not be reached on port ${port}. If a Flow Studio Chrome window is already open, close it and try again.`,
  );
}

export async function getBrowser(account: Account = currentAccount()): Promise<Browser> {
  const key = account.name.toLowerCase();
  const open = browsers.get(key);
  if (open?.isConnected()) return open;
  let pending = connecting.get(key);
  if (!pending) {
    pending = (async () => {
      const port = (await ownChrome(account)) ?? (await launchChrome(account));
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      browsers.set(key, b);
      return b;
    })().finally(() => connecting.delete(key));
    connecting.set(key, pending);
  }
  return pending;
}

// Closes Flow Studio's own Chrome window for one account, and only that one. Returns false when it was not running.
export async function closeChrome(account: Account = currentAccount()): Promise<boolean> {
  const port = await ownChrome(account);
  if (!port) return false;
  const key = account.name.toLowerCase();
  const existing = browsers.get(key);
  const b = existing?.isConnected() ? existing : await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  browsers.delete(key);
  try {
    const session = await b.newBrowserCDPSession();
    await session.send("Browser.close");
  } catch {
    // Chrome drops the connection as it closes, which is the result we want.
  }
  for (let i = 0; i < 40; i++) {
    if (!(await browserIdAt(port))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Flow Studio's Chrome window for account "${account.name}" did not close.`);
}

// Closes every account's Chrome window that Flow Studio owns, returning the names of those closed.
export async function closeAllOwnChromes(): Promise<string[]> {
  const closed: string[] = [];
  for (const account of listAccounts()) {
    if (await closeChrome(account)) closed.push(account.name);
  }
  return closed;
}

export async function getFlowPage(account: Account = currentAccount()): Promise<Page> {
  const b = await getBrowser(account);
  const context = b.contexts()[0];
  if (!context) throw new Error(`Chrome for account "${account.name}" has no browser context; restart that Flow Chrome window.`);
  const wantedProject = process.env.FLOW_MCP_PROJECT ?? "";
  // FLOW_MCP_PROJECT (a project id) is a test hook: drive only that project's tab, never the one the real server uses.
  const flowPages = context.pages().filter((p) => FLOW_HOSTS.test(p.url()) && (!wantedProject || p.url().includes(wantedProject)));
  // A login launch can leave the Flow marketing page open beside the signed-in
  // dashboard or a project. Prefer the project, then the dashboard, so status
  // checks do not mistake `/about` for a signed-out session.
  const existing =
    flowPages.find((p) => /\/project\//.test(p.url())) ??
    flowPages.find((p) => !/\/about(?:[/?#]|$)/.test(p.url())) ??
    flowPages[0];
  if (existing) {
    await ensureEnglish(existing);
    return existing;
  }
  const page = await context.newPage();
  await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
  await ensureEnglish(page);
  return page;
}

// Reloads Flow in English when it is showing in another language (a page the user opened by hand, or Flow redirecting
// to an address without hl). Sign-in pages are left alone.
export async function ensureEnglish(page: Page): Promise<void> {
  if (!/^https:\/\/flow\.google\.com\//.test(page.url())) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  const now = await lang();
  if (!now || /^en\b/i.test(now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new Error(
      `Flow is showing in "${after}" and would not switch to English. flow-mcp finds Flow's buttons by their English names. ` +
        `Add ?hl=en to the end of Flow's address in the Flow Chrome window, or set your Google account's language to English (myaccount.google.com/language).`,
    );
  }
}
