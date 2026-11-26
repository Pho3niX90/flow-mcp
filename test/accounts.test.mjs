import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  accountDir,
  addAccount,
  collectionsDir,
  downloadDir,
  listAccounts,
  looksFile,
  MAIN,
  profileDir,
  setAccountEnabled,
  validateAccountName,
  voicesFile,
} from "../dist/accounts.js";
import { seedDownloadPreferences } from "../dist/chrome.js";
import { workDir } from "../dist/platform.js";

test("validateAccountName rejects traversal, invalid chars, reserved names, and case collisions", () => {
  const existing = [{ name: MAIN }, { name: "work" }];
  assert.equal(validateAccountName("Acc2", existing), "acc2");
  assert.equal(validateAccountName("  team_01-a ", existing), "team_01-a");

  for (const bad of ["", "   ", "../escape", "a/b", "a\\b", "..", "-bad", "_bad", "has space", "a".repeat(32)]) {
    assert.throws(() => validateAccountName(bad, existing), /Account names are/, `expected reject for ${JSON.stringify(bad)}`);
  }
  for (const reserved of ["default", "DEFAULT", "con", "NUL", "com1", "LPT9"]) {
    assert.throws(() => validateAccountName(reserved, existing), /reserved name/, `expected reserved reject for ${reserved}`);
  }
  // Case-insensitive duplicates (critical on Windows/macOS filesystems).
  assert.throws(() => validateAccountName("Main", existing), /already an account/);
  assert.throws(() => validateAccountName("WORK", existing), /already an account/);
});

test("default main account preserves single-account disk layout; extra accounts live under accounts/<name>", () => {
  const home = workDir("flow-accounts-");
  try {
    const initial = listAccounts(home, 9333);
    assert.equal(initial.length, 1);
    assert.deepEqual(initial[0], { name: "main", port: 9333, enabled: true });

    const main = initial[0];
    assert.equal(accountDir(main, home), home);
    assert.equal(profileDir(main, home), join(home, "chrome-profile"));
    assert.equal(downloadDir(main, home), join(home, "downloads"));
    assert.equal(looksFile(main, home), join(home, "characters.json"));
    assert.equal(voicesFile(main, home), join(home, "voices.json"));
    assert.equal(collectionsDir(main, home), join(home, "collections"));

    const acc2 = addAccount("Work", home, 9333);
    assert.deepEqual(acc2, { name: "work", port: 9334, enabled: true });
    assert.equal(accountDir(acc2, home), join(home, "accounts", "work"));
    assert.equal(profileDir(acc2, home), join(home, "accounts", "work", "chrome-profile"));
    assert.equal(downloadDir(acc2, home), join(home, "accounts", "work", "downloads"));
    assert.equal(looksFile(acc2, home), join(home, "accounts", "work", "characters.json"));
    assert.equal(voicesFile(acc2, home), join(home, "accounts", "work", "voices.json"));
    assert.equal(collectionsDir(acc2, home), join(home, "accounts", "work", "collections"));

    setAccountEnabled("work", false, home, 9333);
    assert.equal(listAccounts(home, 9333).find((a) => a.name === "work")?.enabled, false);
    assert.throws(() => setAccountEnabled("main", false, home, 9333), /At least one account has to stay enabled/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("seedDownloadPreferences writes fresh JSON, merges existing prefs, and leaves corrupt files untouched", () => {
  const tmp = workDir("flow-prefs-");
  try {
    // Fresh profile.
    const p1 = join(tmp, "p1");
    const d1 = join(tmp, "d1");
    assert.equal(seedDownloadPreferences(p1, d1), true);
    assert.equal(existsSync(d1), true);
    const parsed1 = JSON.parse(readFileSync(join(p1, "Default", "Preferences"), "utf8"));
    assert.equal(parsed1.download.default_directory, d1);
    assert.equal(parsed1.download.prompt_for_download, false);
    assert.equal(parsed1.profile.default_content_setting_values.automatic_downloads, 1);

    // Existing valid profile keeps unrelated settings intact and adds automatic_downloads when absent.
    const p2 = join(tmp, "p2");
    const d2 = join(tmp, "d2");
    mkdirSync(join(p2, "Default"), { recursive: true });
    writeFileSync(
      join(p2, "Default", "Preferences"),
      JSON.stringify({
        profile: { name: "KeepMe", default_content_setting_values: { notifications: 2 } },
        download: { extensions_to_open: "pdf" },
      }),
    );
    assert.equal(seedDownloadPreferences(p2, d2), true);
    const parsed2 = JSON.parse(readFileSync(join(p2, "Default", "Preferences"), "utf8"));
    assert.equal(parsed2.profile.name, "KeepMe");
    assert.equal(parsed2.profile.default_content_setting_values.notifications, 2);
    assert.equal(parsed2.profile.default_content_setting_values.automatic_downloads, 1);
    assert.equal(parsed2.download.extensions_to_open, "pdf");
    assert.equal(parsed2.download.default_directory, d2);

    // An existing automatic_downloads choice made by the user is never overwritten.
    const p2b = join(tmp, "p2b");
    const d2b = join(tmp, "d2b");
    mkdirSync(join(p2b, "Default"), { recursive: true });
    writeFileSync(
      join(p2b, "Default", "Preferences"),
      JSON.stringify({ profile: { default_content_setting_values: { automatic_downloads: 2 } } }),
    );
    assert.equal(seedDownloadPreferences(p2b, d2b), true);
    const parsed2b = JSON.parse(readFileSync(join(p2b, "Default", "Preferences"), "utf8"));
    assert.equal(parsed2b.profile.default_content_setting_values.automatic_downloads, 2);

    // Corrupt Preferences file is left strictly untouched.
    const p3 = join(tmp, "p3");
    const d3 = join(tmp, "d3");
    mkdirSync(join(p3, "Default"), { recursive: true });
    writeFileSync(join(p3, "Default", "Preferences"), "{not valid json");
    assert.equal(seedDownloadPreferences(p3, d3), false);
    assert.equal(readFileSync(join(p3, "Default", "Preferences"), "utf8"), "{not valid json");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
