import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromeLaunchArgs, formatChromeConnectError, isChrome156ConnectError, isTranslatedHtmlClass } from "../dist/chrome.js";
import { commandLineUses, startProcessCommand } from "../dist/platform.js";

test("an argument with a space is wrapped so Windows passes it as one", () => {
  const command = startProcessCommand("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
    "--user-data-dir=C:\\Users\\Jane Doe\\.flow-mcp\\chrome-profile",
    "--remote-debugging-port=9333",
    "https://flow.google.com/?hl=en",
  ]);
  assert.equal(
    command,
    "Start-Process -FilePath 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -ArgumentList " +
      "'\"--user-data-dir=C:\\Users\\Jane Doe\\.flow-mcp\\chrome-profile\"','--remote-debugging-port=9333','https://flow.google.com/?hl=en' -WindowStyle Normal",
  );
  // A quote inside a path cannot end the PowerShell string early.
  assert.match(startProcessCommand("C:\\it's\\chrome.exe", ["--x"]), /-FilePath 'C:\\it''s\\chrome\.exe'/);
});

test("a program started that way really receives each argument whole", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(join(process.env.FLOW_MCP_TMP ?? tmpdir(), "flow launch test "));
  try {
    const script = join(dir, "args.mjs");
    const out = join(dir, "args.json");
    writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`);
    const args = [script, out, `--user-data-dir=${join(dir, "chrome profile")}`, "--remote-debugging-port=9333", "https://flow.google.com/?hl=en"];
    const command = startProcessCommand(process.execPath, args).replace("-WindowStyle Normal", "-WindowStyle Hidden -Wait");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore", windowsHide: true, timeout: 60_000 });
    assert.ok(existsSync(out), "the started program ran");
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), args.slice(2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a browser is ours only when it uses this profile folder and this port", () => {
  const profile = "E:\\cache\\flow-mcp\\chrome-profile";
  const started = (dir, port, quoted = false) =>
    `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ${quoted ? `"--user-data-dir=${dir}"` : `--user-data-dir=${dir}`} --remote-debugging-port=${port} --no-first-run https://flow.google.com/?hl=en`;

  assert.equal(commandLineUses(started(profile, 9333), profile, 9333, true), true);
  // Windows paths differ in case and in which way the slashes lean.
  assert.equal(commandLineUses(started("e:/CACHE/flow-mcp/chrome-profile", 9333), profile, 9333, true), true);
  assert.equal(commandLineUses(started("C:\\Users\\Jane Doe\\.flow-mcp\\chrome-profile", 9333, true), "C:\\Users\\Jane Doe\\.flow-mcp\\chrome-profile", 9333, true), true);
  // Someone else's debugging Chrome on the same port, another account's profile, or our profile on another port.
  assert.equal(commandLineUses(started("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data", 9333), profile, 9333, true), false);
  assert.equal(commandLineUses(started(`${profile}-2`, 9333), profile, 9333, true), false);
  assert.equal(commandLineUses(started("E:\\cache\\flow-mcp\\accounts\\work\\chrome-profile", 9333), profile, 9333, true), false);
  assert.equal(commandLineUses(started(profile, 9334), profile, 9333, true), false);
  assert.equal(commandLineUses(started(profile, 93330), profile, 9333, true), false);
  // Elsewhere, case matters.
  assert.equal(commandLineUses("/usr/bin/google-chrome --user-data-dir=/home/me/.flow-mcp/chrome-profile --remote-debugging-port=9333", "/home/me/.flow-mcp/chrome-profile", 9333, false), true);
  assert.equal(commandLineUses("/usr/bin/google-chrome --user-data-dir=/home/Me/.flow-mcp/chrome-profile --remote-debugging-port=9333", "/home/me/.flow-mcp/chrome-profile", 9333, false), false);
});

test("chromeLaunchArgs disables Chrome page translation with a single --disable-features switch", () => {
  const args = chromeLaunchArgs("/tmp/profile", 9333);
  const disableFeatureFlags = args.filter((a) => a.startsWith("--disable-features="));
  assert.equal(disableFeatureFlags.length, 1);
  assert.ok(disableFeatureFlags[0].split("=")[1].split(",").includes("Translate"));
});

test("isTranslatedHtmlClass detects Chrome translated-ltr and translated-rtl classes only", () => {
  assert.equal(isTranslatedHtmlClass("translated-ltr"), true);
  assert.equal(isTranslatedHtmlClass("dark translated-rtl compact"), true);
  assert.equal(isTranslatedHtmlClass("TRANSLATED-LTR"), true);
  assert.equal(isTranslatedHtmlClass(""), false);
  assert.equal(isTranslatedHtmlClass(null), false);
  assert.equal(isTranslatedHtmlClass(undefined), false);
  assert.equal(isTranslatedHtmlClass("dark-theme"), false);
  assert.equal(isTranslatedHtmlClass("not-translated-ltr"), false);
  assert.equal(isTranslatedHtmlClass("translated-ltr-custom"), false);
});

test("isChrome156ConnectError recognizes the Chrome 156 CDP error and leaves other errors untouched", () => {
  const chrome156Err = new Error(
    "browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior): Browser context management is not supported.",
  );
  assert.equal(isChrome156ConnectError(chrome156Err), true);
  const wrapped = formatChromeConnectError(chrome156Err);
  assert.ok(wrapped instanceof Error);
  assert.match(wrapped.message, /Chrome 156/i);
  assert.match(wrapped.message, /Update Google Chrome/i);
  assert.match(wrapped.message, /158/);

  const other = new Error("connect ECONNREFUSED 127.0.0.1:9333");
  assert.equal(isChrome156ConnectError(other), false);
  assert.equal(formatChromeConnectError(other), other);
  assert.equal(isChrome156ConnectError(null), false);
});
