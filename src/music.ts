import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Locator, Page, Response } from "playwright-core";
import { checkNotTranslated, getMusicPage, MUSIC_URL } from "./chrome.js";
import {
  MUSIC_FORMAT_EXT,
  MUSIC_FORMAT_LABEL,
  checkMusicCreditsBefore,
  classifyMusicSignedIn,
  classifyMusicStatus,
  formatMusicLength,
  matchesMusicModel,
  measureMusicSpend,
  parseMusicClipsResponse,
  parseMusicCredits,
  parseMusicPlan,
  resolveMusicSongQuery,
  validateMusicBpm,
  validateMusicFormats,
  validateMusicSeed,
  type MusicClip,
  type MusicFormat,
  type MusicParams,
} from "./music-parse.js";
import { downloadsNow, extensionOf, oneDownloadAtATime, useOwnDownloadDir, waitForDownloadedFile } from "./page-downloads.js";
import { moveFile } from "./platform.js";
import { trace } from "./trace.js";

const SESSION_URL = `${MUSIC_URL}session`;
const LIBRARY_URL = `${MUSIC_URL}library/my-songs`;
const SONG_TIMEOUT_MS = 6 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
// The library loads this many songs at a time.
const LIBRARY_PAGE = 20;

export const MUSIC_SIGNIN_HINT =
  "Not signed in to Flow Music. Run `npm run login -- --music` and sign in with Google in the Flow Music window.";

export interface MusicState {
  url: string;
  signedIn: boolean;
  plan?: string;
  credits_remaining?: number;
  tokens_remaining?: number;
  hint?: string;
}

// Thrown when Generate was already pressed and the outcome could not be confirmed before timing out, so flow_retry
// never silently generates a second copy and spends credits twice.
export class MusicOutcomeUnknownError extends Error {
  readonly outcomeUnknown = true;
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

async function probeSignedIn(page: Page, waitMs = 4000): Promise<boolean> {
  const logIn = page
    .getByRole("button", { name: "Log in", exact: true })
    .or(page.getByRole("button", { name: "Continue with Google", exact: true }))
    .first();
  const signedInNav = page
    .getByRole("link", { name: "New session", exact: true })
    .or(page.getByRole("link", { name: "Songs", exact: true }))
    .first();
  await logIn.or(signedInNav).first().waitFor({ state: "visible", timeout: waitMs }).catch(() => {});
  const [logInVisible, signedInNavVisible] = await Promise.all([
    logIn.isVisible().catch(() => false),
    signedInNav.isVisible().catch(() => false),
  ]);
  return classifyMusicSignedIn({ logInVisible, signedInNavVisible }) === true;
}

// The first answer to a matching request whose body can actually be read as JSON, or null after the time limit.
// "The first matching response" is not enough: around a reload the page sends some requests twice, and the body of the
// one that was cut off by the reload cannot be read, so taking that one gave no balance at all (seen live 2026-11-26).
function waitJsonResponse(page: Page, urlTest: (url: string) => boolean, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    const done = (value: unknown) => {
      clearTimeout(timer);
      page.off("response", onResponse);
      resolve(value);
    };
    const onResponse = async (res: Response) => {
      if (!urlTest(res.url()) || !res.ok()) return;
      const body: unknown = await res.json().catch(() => null);
      if (body !== null && typeof body === "object") done(body);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    page.on("response", onResponse);
  });
}

// Flow Music's /__api/billing/* endpoints require the page's own auth headers, so we never call them ourselves: we
// listen to the page's own responses during a reload or navigation. Never call this while a music job is running.
async function readBillingViaReload(page: Page): Promise<{ plan?: string; credits_remaining?: number; tokens_remaining?: number }> {
  trace("music: reading billing via reload");
  const creditsP = waitJsonResponse(page, (u) => u.includes("/__api/billing/credits"), 12_000);
  const subP = waitJsonResponse(page, (u) => u.includes("/__api/billing/subscription"), 12_000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await checkNotTranslated(page, "music");
  const [creditsBody, subBody] = await Promise.all([creditsP, subP]);
  const credits = parseMusicCredits(creditsBody);
  const plan = parseMusicPlan(subBody);
  trace(`music: billing read (credits=${credits.credits_remaining ?? "unknown"}, plan=${plan ?? "unknown"})`);
  return { ...credits, ...(plan ? { plan } : {}) };
}

// Reads Flow Music session status. Pass `readCredits: false` whenever a music job is running so the window is never reloaded.
export async function getMusicState(opts: { readCredits?: boolean } = {}): Promise<MusicState> {
  const page = await getMusicPage();
  trace("music state: checking sign-in");
  const signedIn = await probeSignedIn(page);
  if (!signedIn) {
    trace("music state: signed out");
    return { url: page.url(), signedIn: false, hint: MUSIC_SIGNIN_HINT };
  }
  if (opts.readCredits) {
    const billing = await readBillingViaReload(page);
    return { url: page.url(), signedIn: true, ...billing };
  }
  return { url: page.url(), signedIn: true };
}

// The compose panel slides off-screen horizontally while staying "visible" to Playwright; it is on screen only when
// the Generate button's bounding box sits fully inside the viewport.
async function isComposePanelOnScreen(page: Page): Promise<boolean> {
  const gen = page.getByRole("button", { name: "Generate", exact: true }).first();
  const box = await gen.boundingBox({ timeout: 2000 }).catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) return false;
  const vp =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null));
  if (!vp) return false;
  return box.x >= 0 && box.x + box.width <= vp.width && box.y >= 0 && box.y + box.height <= vp.height;
}

async function ensureComposePanelOpen(page: Page): Promise<void> {
  if (await isComposePanelOnScreen(page)) {
    trace("music: compose panel already on screen");
    return;
  }
  trace("music: sliding compose panel open");
  const toggle = page.getByRole("button", { name: "Toggle compose panel", exact: true }).first();
  await toggle.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error('Could not find Flow Music\'s "Toggle compose panel" button.');
  });
  await toggle.click({ timeout: 5000 });
  for (let i = 0; i < 12; i++) {
    await pause(page, 250);
    if (await isComposePanelOnScreen(page)) {
      trace("music: compose panel on screen");
      return;
    }
  }
  throw new Error("Pressed Toggle compose panel, but Flow Music's compose panel did not slide into view.");
}

async function setSwitch(page: Page, name: string, wanted: boolean): Promise<void> {
  const sw = page.getByRole("switch", { name, exact: true }).first();
  await sw.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error(`Could not find Flow Music switch "${name}".`);
  });
  const now = (await sw.getAttribute("aria-checked", { timeout: 2000 }).catch(() => null)) === "true";
  if (now === wanted) return;
  await sw.click({ timeout: 5000 });
  for (let i = 0; i < 8; i++) {
    await pause(page, 200);
    const after = (await sw.getAttribute("aria-checked", { timeout: 2000 }).catch(() => null)) === "true";
    if (after === wanted) return;
  }
  throw new Error(`Could not set Flow Music switch "${name}" to ${wanted ? "on" : "off"}.`);
}

function advancedControlAfterLabel(page: Page, labelText: string, tag: "input" | "button"): Locator {
  return page.locator(`xpath=//label[normalize-space(.)="${labelText}"]/following::${tag}[1]`).first();
}

async function setAdvancedInput(page: Page, labelText: "BPM" | "Length" | "Seed", wanted: string): Promise<void> {
  const field = advancedControlAfterLabel(page, labelText, "input");
  await field.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error(`Advanced sound field "${labelText}" did not appear after enabling advanced sound mode.`);
  });
  await field.fill(wanted, { timeout: 5000 });
  await field.press("Tab", { timeout: 3000 }).catch(() => {});
  await pause(page, 300);
  const shown = (await field.inputValue({ timeout: 2000 }).catch(() => "")).trim();
  if (shown !== wanted) {
    throw new Error(`Flow Music did not keep ${labelText} "${wanted}" (field shows "${shown || "empty"}"). Nothing was generated.`);
  }
}

// Isolated assumption: the Model button opens a menu whose entries carry role=menuitem, role=option, or button elements
// inside role=menu/role=listbox. Confirmed by reading back the Model button text after clicking.
async function pickMusicModel(page: Page, wanted: string): Promise<void> {
  const button = advancedControlAfterLabel(page, "Model", "button");
  await button.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error('Advanced sound field "Model" did not appear after enabling advanced sound mode.');
  });
  const current = (await button.innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  if (matchesMusicModel(current, wanted)) return;

  await button.click({ timeout: 5000 });
  const options = page.locator('[role="menuitem"], [role="option"], [role="menu"] button, [role="listbox"] button');
  await options.first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  const count = await options.count().catch(() => 0);
  const offered: string[] = [];
  let chosen = false;
  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    if (!(await opt.isVisible().catch(() => false))) continue;
    const text = (await opt.innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    offered.push(text);
    if (matchesMusicModel(text, wanted)) {
      await opt.click({ timeout: 5000 });
      chosen = true;
      break;
    }
  }
  if (!chosen) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `Flow Music has no model matching "${wanted}". ${offered.length ? `Offered: ${offered.join(" | ")}` : "Model menu did not open."}`,
    );
  }
  await pause(page, 300);
  const after = (await button.innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  if (!matchesMusicModel(after, wanted)) {
    throw new Error(`Flow Music did not keep model "${wanted}" (Model button shows "${after || "unknown"}"). Nothing was generated.`);
  }
}

// Isolated assumption: Details heading is a heading element (h1-h6 or role=heading) followed by the maxlength=100 title
// textarea, falling back to the only maxlength=100 textarea in the compose panel.
async function setSongTitle(page: Page, title: string): Promise<void> {
  const expand = page.getByRole("button", { name: "Expand Details section", exact: true }).first();
  if (await expand.isVisible().catch(() => false)) {
    await expand.click({ timeout: 5000 });
    await page.getByRole("button", { name: "Collapse Details section", exact: true }).first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  }
  const box = page
    .locator(
      'xpath=//*[self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6 or @role="heading"][normalize-space(.)="Details"]/following::textarea[@maxlength="100"][1]',
    )
    .or(page.locator('textarea[maxlength="100"]'))
    .first();
  await box.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error('Could not find the song title box (maxlength 100) inside Flow Music\'s Details section.');
  });
  await box.fill(title, { timeout: 5000 });
  const shown = (await box.inputValue({ timeout: 2000 }).catch(() => "")).trim();
  if (shown !== title) {
    throw new Error(`Flow Music did not keep song title "${title}" (field shows "${shown || "empty"}"). Nothing was generated.`);
  }
}

// Isolated fallback: only used if network listeners missed the /__api/audio-create-song-status or /__api/clips responses.
async function fallbackDetectFinishedSong(page: Page, beforeIds: Set<string>): Promise<string | undefined> {
  const generatingVisible = await page
    .getByRole("status")
    .filter({ hasText: /Generating\b/i })
    .first()
    .isVisible()
    .catch(() => false);
  if (generatingVisible) return undefined;
  const hrefs = await page
    .locator('a[href^="/song/"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))
    .catch(() => [] as string[]);
  for (const href of hrefs) {
    const id = href.match(/^\/song\/([^/?#]+)/)?.[1];
    if (id && !beforeIds.has(id)) return id;
  }
  return undefined;
}

// Isolated DOM scoping: locates the exact "More options for ..." button belonging to `a[href="/song/<clipId>"]` by
// walking up to the closest ancestor that contains exactly one "More options for ..." button, so another song's menu
// can never be clicked by mistake.
async function moreOptionsButtonForClip(page: Page, clipId: string): Promise<Locator> {
  const link = page.locator(`a[href="/song/${clipId}"]`).first();
  await link.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {
    throw new Error(`Could not find song "${clipId}" (a[href="/song/${clipId}"]) on the Flow Music page.`);
  });
  await link.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  let ancestor = link.locator("xpath=..");
  for (let depth = 0; depth < 7; depth++) {
    const buttons = ancestor.getByRole("button", { name: /^More options for / });
    const count = await buttons.count().catch(() => 0);
    if (count === 1) return buttons.first();
    if (count > 1) break;
    ancestor = ancestor.locator("xpath=..");
  }
  throw new Error(`Could not locate a unique "More options" button for song "${clipId}" without risking another song's menu.`);
}

// Isolated menu item locator: Flow Music's menus use role=menuitem or button elements with exact text.
function menuOption(page: Page, exactName: string): Locator {
  return page
    .getByRole("menuitem", { name: exactName, exact: true })
    .or(page.getByRole("button", { name: exactName, exact: true }))
    .first();
}

// Presses a menu item with a plain click at its centre. Playwright's own click first scrolls the item "into view if
// needed", and any scroll makes this page close its menus: in the library the format item was closed under the click
// and the download failed with "<html> intercepts pointer events" (seen live 2026-11-26). An item that is not inside
// the window is refused instead of scrolled to.
async function pressMenuItem(page: Page, item: Locator, what: string): Promise<void> {
  await item.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error(`${what} did not appear in Flow Music's menu.`);
  });
  // The menu slides and grows into place. Its place is only known once it has stopped moving: a click aimed at where
  // the item was mid-way lands beside it, and nothing is downloaded.
  let box = await item.boundingBox({ timeout: 2000 }).catch(() => null);
  for (let i = 0; i < 20; i++) {
    await pause(page, 120);
    const now = await item.boundingBox({ timeout: 2000 }).catch(() => null);
    const still = box && now && Math.abs(box.x - now.x) < 0.5 && Math.abs(box.y - now.y) < 0.5 && Math.abs(box.width - now.width) < 0.5 && Math.abs(box.height - now.height) < 0.5;
    box = now;
    if (still) break;
  }
  const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null);
  if (!box || !vp || box.x < 0 || box.y < 0 || box.x + box.width > vp.width || box.y + box.height > vp.height) {
    throw new Error(`${what} is in Flow Music's menu but outside the window, so it was not pressed. Make the Flow Music window larger and try again.`);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function closeMenus(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await pause(page, 200);
  await page.keyboard.press("Escape").catch(() => {});
}

// Downloads one clip currently shown on `page` (session view or library view) in every requested format.
async function downloadSongOnPage(page: Page, clipId: string, outputStem: string, formats: MusicFormat[]): Promise<string[]> {
  mkdirSync(dirname(outputStem), { recursive: true });
  const files: string[] = [];
  for (const fmt of formats) {
    const label = MUSIC_FORMAT_LABEL[fmt];
    const expectedExt = MUSIC_FORMAT_EXT[fmt];
    trace(`music: downloading ${clipId} as ${label}`);
    const saved = await oneDownloadAtATime(async () => {
      await useOwnDownloadDir(page);
      const before = downloadsNow();
      try {
        const more = await moreOptionsButtonForClip(page, clipId);
        await more.click({ timeout: 5000 });
        await pressMenuItem(page, menuOption(page, "Download"), `"Download" for song "${clipId}"`);
        await pressMenuItem(page, menuOption(page, label), `Format "${label}" for song "${clipId}"`);
        const arrived = await waitForDownloadedFile(page, before, DOWNLOAD_TIMEOUT_MS, "music");
        const actualExt = extensionOf(arrived);
        if (actualExt !== expectedExt) {
          throw new Error(
            `Requested ${label} (${expectedExt}) for song "${clipId}", but Flow Music downloaded ${actualExt}; left untouched at ${arrived}.`,
          );
        }
        const dest = `${outputStem}${actualExt}`;
        moveFile(arrived, dest);
        trace(`music: saved ${dest}`);
        return dest;
      } finally {
        await closeMenus(page);
      }
    });
    files.push(saved);
  }
  return files;
}

// Isolated assumption (not mapped live): scrolling the library window/main container loads the next 20 clips via
// GET /__api/clips/auth-user?offset=...; the first 20 never call this function.
async function scrollLibraryForMore(page: Page): Promise<boolean> {
  trace("music library: scrolling for next page");
  const nextBatchP = waitJsonResponse(page, (u) => u.includes("/__api/clips/auth-user"), 5000);
  await page
    .evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      const main = document.querySelector("main") as HTMLElement | null;
      if (main) main.scrollTop = main.scrollHeight;
    })
    .catch(() => {});
  const body = await nextBatchP;
  return parseMusicClipsResponse(body).length > 0;
}

// Opens /library/my-songs and collects clip records from Flow Music's own /__api/clips/auth-user responses.
async function openLibraryAndReadClips(page: Page, limit: number): Promise<MusicClip[]> {
  const byId = new Map<string, MusicClip>();
  let firstBatchDone = false;
  // How many songs the newest answer held. Fewer than a full page of 20 means there is no further page, so nothing
  // is scrolled: the scroll cost five seconds each time and left the page somewhere else.
  let lastBatch = 0;
  const onResponse = async (res: Response) => {
    if (!res.url().includes("/__api/clips/auth-user") || !res.ok()) return;
    const body = await res.json().catch(() => null);
    const batch = parseMusicClipsResponse(body);
    lastBatch = batch.length;
    for (const clip of batch) {
      if (!byId.has(clip.id)) byId.set(clip.id, clip);
    }
    firstBatchDone = true;
  };
  page.on("response", onResponse);
  try {
    trace("music library: opening /library/my-songs");
    await page.goto(LIBRARY_URL, { waitUntil: "domcontentloaded" });
    await checkNotTranslated(page, "music");
    if (!(await probeSignedIn(page))) throw new Error(MUSIC_SIGNIN_HINT);
    for (let i = 0; i < 60 && !firstBatchDone; i++) await pause(page, 250);
    trace(`music library: loaded ${byId.size} clip(s)`);
    while (byId.size < limit && lastBatch >= LIBRARY_PAGE) {
      const before = byId.size;
      const gotMore = await scrollLibraryForMore(page);
      await pause(page, 300);
      if (!gotMore || byId.size === before) break;
      trace(`music library: now at ${byId.size} clip(s)`);
    }
  } finally {
    page.off("response", onResponse);
  }
  return [...byId.values()];
}

export async function listMusicSongs(limit = 20): Promise<MusicClip[]> {
  const page = await getMusicPage();
  const clips = await openLibraryAndReadClips(page, limit);
  return clips.slice(0, limit);
}

export async function downloadMusicSongs(
  queries: string[],
  outputStemForIndex: (i: number) => string,
  formats?: MusicFormat[],
): Promise<{ clips: MusicClip[]; files: string[] }> {
  const cleanFormats = validateMusicFormats(formats);
  const page = await getMusicPage();
  // Load library clips (first 20 without scrolling; scroll further only if a query isn't in the first 20).
  const loaded = await openLibraryAndReadClips(page, 20);
  const resolved: MusicClip[] = [];
  for (const q of queries) {
    let res = resolveMusicSongQuery(loaded, q);
    if (!res.ok) {
      // Try loading additional library pages up to 100 clips before giving up.
      const more = await openLibraryAndReadClips(page, 100);
      res = resolveMusicSongQuery(more, q);
    }
    if (!res.ok) throw new Error(res.error);
    resolved.push(res.clip);
  }
  const files: string[] = [];
  for (const [i, clip] of resolved.entries()) {
    // Ensure the clip's link is present in the library DOM; scroll if it was beyond the initial viewport.
    if ((await page.locator(`a[href="/song/${clip.id}"]`).count().catch(() => 0)) === 0) {
      for (let step = 0; step < 5 && (await page.locator(`a[href="/song/${clip.id}"]`).count().catch(() => 0)) === 0; step++) {
        if (!(await scrollLibraryForMore(page))) break;
      }
    }
    const downloaded = await downloadSongOnPage(page, clip.id, outputStemForIndex(i), cleanFormats);
    files.push(...downloaded);
  }
  return { clips: resolved, files };
}

export interface GenerateSongResult {
  clip: MusicClip;
  files: string[];
  credits_before?: number;
  credits_after?: number;
  credits_spent?: number;
}

// Drives Flow Music's compose panel to make one song and download it in every requested format.
export async function generateMusicSong(
  params: MusicParams,
  maxCredits: number,
  outputStem: string,
  onProgress?: (text: string) => void,
): Promise<GenerateSongResult> {
  // Validate every field before touching the browser so bad arguments fail immediately.
  const sound = params.sound.trim();
  if (!sound) throw new Error("sound description cannot be empty.");
  if (sound.length > 3000) throw new Error("sound description must be 3000 characters or fewer.");
  const lyrics = params.lyrics?.trim() ?? "";
  if (lyrics.length > 3000) throw new Error("lyrics must be 3000 characters or fewer.");
  const instrumental = params.instrumental ?? !lyrics;
  const title = params.title?.trim() ?? "";
  if (title.length > 100) throw new Error("song title must be 100 characters or fewer.");
  const formattedLength = params.length_seconds !== undefined ? formatMusicLength(params.length_seconds) : undefined;
  const formattedBpm = params.bpm !== undefined ? validateMusicBpm(params.bpm) : undefined;
  const formattedSeed = params.seed !== undefined ? validateMusicSeed(params.seed) : undefined;
  const formats = validateMusicFormats(params.formats);
  checkMusicCreditsBefore(maxCredits);

  const page = await getMusicPage();
  trace("music: opening new session");
  onProgress?.("opening Flow Music session");
  const creditsBeforeP = waitJsonResponse(page, (u) => u.includes("/__api/billing/credits"), 10_000);
  await page.goto(SESSION_URL, { waitUntil: "domcontentloaded" });
  await checkNotTranslated(page, "music");
  if (!(await probeSignedIn(page))) throw new Error(MUSIC_SIGNIN_HINT);
  const creditsBefore = parseMusicCredits(await creditsBeforeP).credits_remaining;
  trace(`music: session ready (credits_before=${creditsBefore ?? "unknown"})`);
  checkMusicCreditsBefore(maxCredits, creditsBefore);

  await ensureComposePanelOpen(page);

  await setSwitch(page, "Toggle instrumental mode", instrumental);
  if (!instrumental && lyrics) {
    const lyricsBox = page.getByRole("textbox", { name: "Lyrics", exact: true }).first();
    await lyricsBox.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
      throw new Error('Could not find Flow Music\'s "Lyrics" textbox.');
    });
    await lyricsBox.fill(lyrics, { timeout: 5000 });
  }
  const soundBox = page.getByRole("textbox", { name: "Sound description", exact: true }).first();
  await soundBox.waitFor({ state: "visible", timeout: 5000 }).catch(() => {
    throw new Error('Could not find Flow Music\'s "Sound description" textbox.');
  });
  await soundBox.fill(sound, { timeout: 5000 });
  trace("music: prompt filled");

  if (formattedBpm || formattedLength || formattedSeed || params.model) {
    await setSwitch(page, "Toggle advanced sound mode", true);
    if (formattedBpm) await setAdvancedInput(page, "BPM", formattedBpm);
    if (formattedLength) await setAdvancedInput(page, "Length", formattedLength);
    if (formattedSeed) await setAdvancedInput(page, "Seed", formattedSeed);
    if (params.model) await pickMusicModel(page, params.model);
    trace("music: advanced sound settings confirmed");
  }

  if (title) {
    await setSongTitle(page, title);
    trace("music: title set");
  }

  const genBtn = page.getByRole("button", { name: "Generate", exact: true }).first();
  if (!(await genBtn.isEnabled({ timeout: 3000 }).catch(() => false))) {
    throw new Error("Flow Music's Generate button is disabled; check the sound description and inputs. Nothing was generated.");
  }

  // Snapshot any existing song links on the session page before pressing Generate (fallback only).
  const beforeSongIds = new Set(
    (
      await page
        .locator('a[href^="/song/"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("href")?.match(/^\/song\/([^/?#]+)/)?.[1] ?? ""))
        .catch(() => [] as string[])
    ).filter(Boolean),
  );

  // Register listeners BEFORE pressing Generate so no fast response can be missed.
  const clipsById = new Map<string, MusicClip>();
  let completedClipId: string | undefined;
  let completed = false;
  let failedReason: string | undefined;
  let creditsAfterFromEvent: number | undefined;

  const onResponse = async (res: Response) => {
    const url = res.url();
    if (!res.ok()) return;
    if (url.includes("/__api/audio-create-song-status/")) {
      const body = await res.json().catch(() => null);
      const status = classifyMusicStatus(body);
      if (status.state === "complete") {
        completed = true;
        if (status.clipId) completedClipId = status.clipId;
      } else if (status.state === "failed") {
        failedReason = status.reason;
      }
    } else if (url.endsWith("/__api/clips") || url.includes("/__api/clips?")) {
      const body = await res.json().catch(() => null);
      for (const clip of parseMusicClipsResponse(body)) clipsById.set(clip.id, clip);
    } else if (url.includes("/__api/billing/credits")) {
      // Only a balance reported once the song is finished counts as "after". The page also asks for its balance at
      // other moments, and one read while the song was still being made is the balance before the charge: taken as
      // "after", it would show every song as free and the spending guard would never see an overcharge.
      if (!completed) return;
      const body = await res.json().catch(() => null);
      const c = parseMusicCredits(body).credits_remaining;
      if (c !== undefined) creditsAfterFromEvent = c;
    }
  };

  page.on("response", onResponse);
  let finishedClip: MusicClip | undefined;
  try {
    onProgress?.("generating song in Flow Music");
    await genBtn.click({ timeout: 5000 });
    trace("music: generate pressed");

    const startedAt = Date.now();
    const deadline = startedAt + SONG_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await pause(page, 1000);
      if (failedReason) {
        throw new Error(`Flow Music failed to generate the song (${failedReason}).`);
      }
      if (completed) {
        // Wait briefly for the POST /__api/clips record matching completedClipId (or the link in the DOM).
        if (completedClipId && clipsById.has(completedClipId)) {
          finishedClip = clipsById.get(completedClipId);
          break;
        }
        if (completedClipId) {
          for (let w = 0; w < 16 && !clipsById.has(completedClipId); w++) await pause(page, 500);
          finishedClip = clipsById.get(completedClipId) ?? { id: completedClipId, title: title || "Untitled", has_wav: false };
          break;
        }
        const firstClip = [...clipsById.values()][0];
        if (firstClip) {
          finishedClip = firstClip;
          break;
        }
      }
      // Fallback only if network answers were missed after generation has had time to run.
      if (Date.now() - startedAt >= 12_000) {
        const fallbackId = await fallbackDetectFinishedSong(page, beforeSongIds);
        if (fallbackId) {
          finishedClip = clipsById.get(fallbackId) ?? { id: fallbackId, title: title || "Untitled", has_wav: false };
          trace(`music: fallback detected finished song ${fallbackId}`);
          break;
        }
      }
    }
  } finally {
    page.off("response", onResponse);
  }

  if (!finishedClip) {
    throw new MusicOutcomeUnknownError(
      `Timed out after ${Math.round(SONG_TIMEOUT_MS / 1000)}s waiting for Flow Music to finish. Because Generate was already pressed, the song may exist and credits may have been spent — check flow_music_songs and download it with flow_music_download instead of generating again.`,
    );
  }

  trace(`music: generation complete (${finishedClip.id})`);
  onProgress?.("downloading song");
  const made = finishedClip;
  // From here the song exists and has been paid for. A download that fails must say so, with the song's id, and must
  // not look like a plain failure that flow_retry would answer by making (and paying for) the song a second time.
  const files = await downloadSongOnPage(page, made.id, outputStem, formats).catch((err: unknown) => {
    trace(`music: download failed after generation (${err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : err})`);
    throw new MusicOutcomeUnknownError(
      `The song was made and is in your Flow Music library (id ${made.id}, "${made.title}"), but it could not be downloaded: ${err instanceof Error ? err.message.split("\n")[0] : String(err)} Fetch it with flow_music_download and that id; do not generate it again.`,
    );
  });

  // Measure credits spent after downloads are done (never reload while generating).
  let creditsAfter = creditsAfterFromEvent;
  if (creditsAfter === undefined && creditsBefore !== undefined) {
    creditsAfter = (await readBillingViaReload(page).catch(() => ({ credits_remaining: undefined }))).credits_remaining;
  }
  const creditsSpent = measureMusicSpend(creditsBefore, creditsAfter);
  trace(`music: finished (credits_spent=${creditsSpent ?? "unknown"})`);

  return {
    clip: finishedClip,
    files,
    credits_before: creditsBefore,
    credits_after: creditsAfter,
    credits_spent: creditsSpent,
  };
}
