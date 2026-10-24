import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { currentAccount, downloadDir, HOME_DIR, profileDir, type Account } from "./accounts.js";
import { CHROME_HINT } from "./platform.js";

export { HOME_DIR };
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
// Where finished stills, clips and narrations go. FLOW_MCP_OUTPUT may point at another drive (e.g. D:\flow-mcp-out).
export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
export const CDP_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9333);
const cdpUrl = (a: Account) => `http://127.0.0.1:${a.port}`;

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
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

async function cdpUp(a: Account): Promise<boolean> {
  try {
    const res = await fetch(`${cdpUrl(a)}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
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

async function launchChrome(a: Account): Promise<void> {
  const chromePath = chromeExecutable();
  const profile = profileDir(a);
  mkdirSync(profile, { recursive: true });
  seedDownloadPreferences(profile, downloadDir(a));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${a.port}`,
    "--no-first-run",
    "--no-default-browser-check",
    inEnglish(FLOW_URL),
  ];
  // On Windows, MCP servers are spawned hidden (SW_HIDE), which child GUI processes inherit unless started with Normal style.
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath '${chromePath.replace(/'/g, "''")}' -ArgumentList ${args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(",")} -WindowStyle Normal`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
  } else {
    const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
  for (let i = 0; i < 40; i++) {
    if (await cdpUp(a)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome for account "${a.name}" started but CDP port ${a.port} never came up.`);
}

export async function getBrowser(account: Account = currentAccount()): Promise<Browser> {
  const key = account.name.toLowerCase();
  const open = browsers.get(key);
  if (open?.isConnected()) return open;
  let pending = connecting.get(key);
  if (!pending) {
    pending = (async () => {
      if (!(await cdpUp(account))) await launchChrome(account);
      const b = await chromium.connectOverCDP(cdpUrl(account));
      browsers.set(key, b);
      return b;
    })().finally(() => connecting.delete(key));
    connecting.set(key, pending);
  }
  return pending;
}

export async function getFlowPage(account: Account = currentAccount()): Promise<Page> {
  const b = await getBrowser(account);
  const context = b.contexts()[0];
  if (!context) throw new Error(`Chrome for account "${account.name}" has no browser context; restart that Flow Chrome window.`);
  const flowPages = context.pages().filter((p) => FLOW_HOSTS.test(p.url()));
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
