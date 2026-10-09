import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, HOME_DIR } from "./config.js";

export { HOME_DIR };
const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
const SETTINGS_FILE = join(HOME_DIR, "settings.json");

// Every Google account is its own Chrome profile with its own debugging port, Flow project, download folder and queue
// worker, so several accounts generate at the same time. "main" keeps the exact layout flow-mcp always had (same
// folder, same port), so a single-account install sees zero changes. The user signs each one in by hand.
export const MAIN = "main";
const MAIN_PORT = CONFIG.cdpPort;

// Reserved names that must not be used as account folder names (Windows device names and "default").
const RESERVED_NAMES = new Set([
  "default",
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export interface Account {
  name: string;
  port: number;
  enabled: boolean;
}

type Stored = { accounts?: Account[] };

const read = <T>(file: string, fallback: T): T => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};

const write = (file: string, data: unknown, dir = HOME_DIR) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
};

// Validates and normalises a new account name to lowercase so Windows/macOS case-insensitive filesystems never map
// two names ("Work" and "work", or "Main" and "main") onto the same folder.
export function validateAccountName(name: string, existing: { name: string }[]): string {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(clean)) {
    throw new Error("Account names are 1-31 letters, digits, - or _ (e.g. 'work', 'acc2').");
  }
  if (RESERVED_NAMES.has(clean)) {
    throw new Error(`"${clean}" is a reserved name. Pick another account name (e.g. 'work', 'acc2').`);
  }
  if (existing.some((a) => a.name.toLowerCase() === clean)) {
    throw new Error(`There is already an account called "${clean}".`);
  }
  return clean;
}

export function listAccounts(homeDir = HOME_DIR, mainPort = MAIN_PORT): Account[] {
  const stored = read<Stored>(join(homeDir, "accounts.json"), {}).accounts ?? [];
  const main = stored.find((a) => a.name.toLowerCase() === MAIN);
  return [{ name: MAIN, port: mainPort, enabled: main?.enabled ?? true }, ...stored.filter((a) => a.name.toLowerCase() !== MAIN)];
}

export const enabledAccounts = (homeDir = HOME_DIR, mainPort = MAIN_PORT): Account[] => listAccounts(homeDir, mainPort).filter((a) => a.enabled);

export function accountByName(name: string, homeDir = HOME_DIR, mainPort = MAIN_PORT): Account {
  const found = listAccounts(homeDir, mainPort).find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new Error(`No Flow account called "${name}". Known: ${listAccounts(homeDir, mainPort).map((a) => a.name).join(", ")}. Add one with flow_accounts.`);
  return found;
}

// Where account-bound work goes when the caller names no account: the first enabled one.
export const defaultAccount = (homeDir = HOME_DIR, mainPort = MAIN_PORT): Account => enabledAccounts(homeDir, mainPort)[0] ?? listAccounts(homeDir, mainPort)[0];

// "main" keeps the existing top-level HOME_DIR layout; extra accounts live strictly under <HOME_DIR>/accounts/<name>/.
export const accountDir = (a: Account, homeDir = HOME_DIR): string =>
  a.name.toLowerCase() === MAIN ? homeDir : join(homeDir, "accounts", a.name.toLowerCase());

export const profileDir = (a: Account, homeDir = HOME_DIR): string => join(accountDir(a, homeDir), "chrome-profile");
export const downloadDir = (a: Account, homeDir = HOME_DIR): string => join(accountDir(a, homeDir), "downloads");
export const chromeFile = (a: Account, homeDir = HOME_DIR): string => join(accountDir(a, homeDir), "chrome.json");
export const looksFile = (a: Account, homeDir = HOME_DIR): string => join(accountDir(a, homeDir), "characters.json");
export const voicesFile = (a: Account, homeDir = HOME_DIR): string => join(accountDir(a, homeDir), "voices.json");
export const collectionsDir = (a: Account, homeDir = HOME_DIR): string => join(accountDir(a, homeDir), "collections");

export function addAccount(name: string, homeDir = HOME_DIR, mainPort = MAIN_PORT): Account {
  const all = listAccounts(homeDir, mainPort);
  const clean = validateAccountName(name, all);
  const account: Account = { name: clean, port: Math.max(...all.map((a) => a.port)) + 1, enabled: true };
  write(join(homeDir, "accounts.json"), { accounts: [...all, account] }, homeDir);
  return account;
}

export function setAccountEnabled(name: string, enabled: boolean, homeDir = HOME_DIR, mainPort = MAIN_PORT): Account {
  const all = listAccounts(homeDir, mainPort);
  const target = accountByName(name, homeDir, mainPort);
  if (!enabled && all.filter((a) => a.enabled && a.name !== target.name).length === 0) throw new Error("At least one account has to stay enabled.");
  const next = all.map((a) => (a.name === target.name ? { ...a, enabled } : a));
  write(join(homeDir, "accounts.json"), { accounts: next }, homeDir);
  return { ...target, enabled };
}

// The account the current piece of work belongs to. Each queue worker and each direct call runs inside onAccount, so
// getFlowPage() and the download folder follow it without every driver function taking an account argument.
const current = new AsyncLocalStorage<Account>();
export const currentAccount = (): Account => current.getStore() ?? defaultAccount();
export const onAccount = <T>(account: Account | string, work: () => Promise<T>): Promise<T> =>
  current.run(typeof account === "string" ? accountByName(account) : account, work);

// Settings the user chooses once and keeps: for now the image model used whenever a job names none.
export interface Settings {
  default_image_model?: string;
}
export const loadSettings = (): Settings => read<Settings>(SETTINGS_FILE, {});
export const saveSettings = (s: Settings) => write(SETTINGS_FILE, s);
export const defaultImageModel = (): string | undefined => loadSettings().default_image_model;
