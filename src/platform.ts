import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";

// Everything that differs between macOS, Windows and Linux lives here, so the rest of the code stays the same on all
// three. macOS is the tested platform; the Windows and Linux branches are written to each system's own documented
// tools but have not been run on a real machine yet.
export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

// How the panel names this computer and its bin, so nothing says "Mac" on a PC.
export const COMPUTER = IS_MAC ? "this Mac" : IS_WIN ? "this PC" : "this computer";
export const BIN = IS_MAC ? "the Mac's Trash" : IS_WIN ? "the Recycle Bin" : "the Trash";

export const FFMPEG_HINT = IS_MAC ? "brew install ffmpeg" : IS_WIN ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg";

// Where to get Chrome when none of the known paths exists. Flow's selectors were mapped against real Google Chrome;
// a Chromium build can stand in through FLOW_MCP_CHROME, but Google's sign-in sometimes refuses one.
export const CHROME_HINT = IS_LINUX
  ? "install Google Chrome (the .deb at google.com/chrome), or set FLOW_MCP_CHROME to a Chromium build"
  : "install Google Chrome from google.com/chrome, or set FLOW_MCP_CHROME to the Chrome executable path";

export interface ToolLookupEnv {
  isWin?: boolean;
  pathEnv?: string;
  localAppData?: string;
  homeDir?: string;
  exists?: (p: string) => boolean;
  isDir?: (p: string) => boolean;
  listDir?: (p: string) => string[];
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeListDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

export interface SystemToolEnv {
  isWin?: boolean;
  systemRoot?: string;
  exists?: (p: string) => boolean;
}

// Resolves Windows built-in tools (powershell.exe, tar, cmd, curl) to their fixed System32 path so a file with the
// same name in the current working directory or an untrusted PATH entry cannot hijack them.
export function systemTool(name: string, env: SystemToolEnv = {}): string {
  const win = env.isWin ?? IS_WIN;
  if (!win) return name;
  const exists = env.exists ?? existsSync;
  const root = env.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const lower = name.toLowerCase();
  const candidate =
    lower === "powershell" || lower === "powershell.exe"
      ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : join(root, "System32", lower.endsWith(".exe") ? name : `${name}.exe`);
  return exists(candidate) ? candidate : name;
}

// A process started before ffmpeg was installed keeps its old PATH (Claude Desktop's flow-mcp lives for days), so a bare
// "ffmpeg" fails with ENOENT even though winget just installed it. Look on PATH first, then in the places the installers
// put it, and only then give back the bare name so the error message still carries FFMPEG_HINT.
export function findTool(name: string, env: ToolLookupEnv = {}): string {
  const win = env.isWin ?? IS_WIN;
  const exists = env.exists ?? existsSync;
  const isDir = env.isDir ?? safeIsDir;
  const listDir = env.listDir ?? safeListDir;
  const exe = win ? `${name}.exe` : name;
  const pathEnv = env.pathEnv ?? process.env.PATH ?? "";
  const isAbsDir = (dir: string) => (win ? /^[a-zA-Z]:[\\/]|^\\\\/.test(dir) : dir.startsWith("/"));
  for (const dir of pathEnv.split(win ? ";" : ":")) {
    if (!dir || dir === "." || !isAbsDir(dir)) continue;
    if (exists(join(dir, exe))) return join(dir, exe);
  }
  const roots: string[] = [];
  if (win) {
    const local = env.localAppData ?? process.env.LOCALAPPDATA ?? join(env.homeDir ?? homedir(), "AppData", "Local");
    for (const base of [join(local, "Microsoft", "WinGet", "Packages"), join(local, "Microsoft", "WinGet", "Links")]) {
      if (!isDir(base)) continue;
      if (base.endsWith("Links")) roots.push(base);
      else for (const pkg of listDir(base)) if (/ffmpeg/i.test(pkg) && isDir(join(base, pkg))) roots.push(join(base, pkg));
    }
  } else {
    roots.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
  }
  for (const root of roots) {
    const direct = join(root, exe);
    if (exists(direct)) return direct;
    if (!win || !isDir(root)) continue;
    for (const sub of listDir(root)) {
      const subDir = join(root, sub);
      if (!isDir(subDir)) continue;
      const inBin = join(subDir, "bin", exe);
      if (exists(inBin)) return inBin;
    }
  }
  return name;
}

export const ffmpeg = (env?: ToolLookupEnv): string => process.env.FLOW_MCP_FFMPEG ?? findTool("ffmpeg", env);
export const ffprobe = (env?: ToolLookupEnv): string => process.env.FLOW_MCP_FFPROBE ?? findTool("ffprobe", env);

// Where working files go while something is being made: FLOW_MCP_TMP when set; otherwise a "tmp" folder inside
// FLOW_MCP_HOME when that is set, so someone who moved the tool to another drive gets its working files there too
// (a film being cut can be gigabytes, and the system's temp folder is on the system drive); otherwise the system's
// temp folder, as before.
export const TMP_ROOT = process.env.FLOW_MCP_TMP ?? (process.env.FLOW_MCP_HOME ? join(process.env.FLOW_MCP_HOME, "tmp") : tmpdir());

// A new, empty working folder whose name starts with `prefix`. The caller removes it when done.
export function workDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, prefix));
}

// PowerShell single-quoted string: PowerShell treats both ASCII apostrophe and Unicode single quotes (U+2018-U+201B)
// as string delimiters, so double all five.
export const psQuote = (s: string) => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;

export function powershell(script: string, timeout = 120_000, env?: NodeJS.ProcessEnv): string {
  return execFileSync(systemTool("powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    ...(env ? { env } : {}),
  });
}

// The PowerShell command that starts a program in a normal, visible window. Start-Process joins its arguments with
// spaces and adds no quotes of its own, so an argument holding a space (a Chrome profile under "C:\Users\Jane Doe")
// reached the program as two: Chrome then used "C:\Users\Jane" as its profile and opened the rest as a web address.
// Such an argument is wrapped in double quotes, which Windows reads back as one argument.
export function startProcessCommand(file: string, args: string[]): string {
  if (file.includes('"') || args.some((a) => a.includes('"'))) {
    throw new Error('Cannot launch process: double-quote character (") is not allowed in path or arguments.');
  }
  const whole = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
  return `Start-Process -FilePath ${psQuote(file)} -ArgumentList ${args.map((a) => psQuote(whole(a))).join(",")} -WindowStyle Normal`;
}

// The command lines of running programs that were started with a remote-debugging port, for telling whose browser is
// listening on one. Empty when the system would not say.
export function debugBrowserCommandLines(): string[] {
  try {
    const out = IS_WIN
      ? powershell("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--remote-debugging-port=*' } | ForEach-Object { $_.CommandLine }", 20_000)
      : execFileSync("ps", ["-axo", "args="], { encoding: "utf8", timeout: 10_000 });
    // The PowerShell that asks carries the same text in its own command line.
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes("--remote-debugging-port=") && !l.includes("Get-CimInstance"));
  } catch {
    return [];
  }
}

// Whether a command line is a browser using this profile folder and this remote-debugging port.
export function commandLineUses(commandLine: string, profile: string, port: number, win = IS_WIN): boolean {
  if (!new RegExp(`--remote-debugging-port=${port}(?!\\d)`).test(commandLine)) return false;
  const flat = (text: string) => {
    const t = text.replace(/"/g, "").replace(/\\/g, "/");
    return win ? t.toLowerCase() : t;
  };
  const line = flat(commandLine);
  const want = `--user-data-dir=${flat(profile).replace(/\/+$/, "")}`;
  const at = line.indexOf(want);
  if (at < 0) return false;
  // The folder name has to end there: "...\chrome-profile" must not match "...\chrome-profile-2".
  const next = line[at + want.length];
  return next === undefined || next === " " || (next === "/" && [undefined, " "].includes(line[at + want.length + 1]));
}

// Moves a file, also across drives. renameSync cannot cross volumes (EXDEV): on Windows the tool's download folder is
// on C: while the output folder is often elsewhere, such as another drive or Google Drive mount. Falls back to
// copy-then-remove, so the source is only removed once the copy has succeeded.
export function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

// Puts a file or folder in the system's own bin so it can be restored: the Mac's Trash, Windows' Recycle Bin, or the
// freedesktop Trash on Linux. Never deletes anything outright.
export function moveToBin(target: string): string {
  if (IS_MAC) {
    const bin = join(homedir(), ".Trash");
    const name = basename(target);
    const ext = extname(name);
    const dest = existsSync(join(bin, name)) ? join(bin, `${name.slice(0, name.length - ext.length)}-${Date.now()}${ext}`) : join(bin, name);
    renameSync(target, dest);
    return dest;
  }
  if (IS_WIN) {
    const kind = lstatSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
    powershell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}($env:FLOW_MCP_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
      120_000,
      { ...process.env, FLOW_MCP_TARGET: target },
    );
    return BIN;
  }
  try {
    execFileSync("gio", ["trash", target], { stdio: "ignore" });
    return BIN;
  } catch {
    const bin = join(homedir(), ".local", "share", "Trash", "files");
    mkdirSync(bin, { recursive: true });
    const dest = join(bin, `${basename(target)}-${Date.now()}`);
    renameSync(target, dest);
    return dest;
  }
}

// Walks an extracted archive folder safely: ignores hidden/macOS metadata entries, skips symlinks and non-regular
// entries, and verifies every resolved path stays inside `dest`.
export function walkExtractedFiles(dest: string): string[] {
  const rootReal = realpathSync(dest);
  const win = process.platform === "win32";
  const rootNorm = win ? rootReal.toLowerCase() : rootReal;
  const prefix = rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep;
  const insideDest = (p: string): boolean => {
    try {
      const real = realpathSync(p);
      const norm = win ? real.toLowerCase() : real;
      return norm.startsWith(prefix);
    } catch {
      return false;
    }
  };
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || f === "__MACOSX") continue;
      const p = join(dir, f);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (!insideDest(p)) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) files.push(p);
    }
  };
  walk(rootReal);
  return files;
}

// Unpacks a ZIP with the system's own tools: tar on macOS and Windows 10+ is bsdtar, which reads ZIPs; unzip is the
// fallback (Linux, older Windows). Returns every regular file inside, skipping symlinks and escapes.
export function extractZip(zip: string, dest: string): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync(systemTool("tar"), ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
  }
  return walkExtractedFiles(dest);
}

// Opens a page in the default browser.
export function openUrl(url: string): void {
  try {
    if (IS_MAC) execFileSync("open", [url], { stdio: "ignore" });
    else if (IS_WIN) execFileSync(systemTool("cmd"), ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    // Opening the browser is a convenience; the address is printed either way.
  }
}
