import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { CDPSession, Locator, Page } from "playwright-core";
import { accountDir, collectionsDir, currentAccount, defaultImageModel, downloadDir, looksFile, voicesFile } from "./accounts.js";
import { AGENT_BUTTON_RE, AGENT_SWITCH_RE, classifyAgentToggleState } from "./agent-toggle.js";
import { FLOW_URL, OUTPUT_ROOT, ensureEnglish, getFlowPage, inEnglish } from "./chrome.js";
import { FREE_UPSCALE, SYSTEM_DOWNLOADS, SettledFiles, newDownloads, snapshotDownloads, type DownloadWatch } from "./downloads.js";
import type { Job } from "./queue.js";
import { buildCollectionTree, findCollection, parentPath, refOf, splitLibraryRef, type FlowCollection } from "./library.js";
import { extractZip, moveFile, workDir } from "./platform.js";
import { ASB_TOKEN_RE, MEDIA_UUID_RE, OUR_TITLE, characterTilePattern, cssAttrValue, parseVoiceFromSnapshot } from "./tiles.js";
import { matchesModelLabel } from "./video-models.js";

export { refOf, type FlowCollection };

export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  project?: string;
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  hint?: string;
  projects?: string[];
}

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const FAILURE_TEXT = /failed|couldn.t|unable/i;
// Flow's refusal when it suspects automation (seen 2026-10-28 on three free stills in a row): an error tile reading
// "We noticed some unusual activity. Note that browser extensions that modify the page may cause issues." Pressing
// Retry or queueing more is exactly the wrong answer, so the job stops and the queue stops with it.
export const BLOCKED_TEXT = /unusual activity/i;
export const BLOCKED_ERROR =
  'Flow refused this generation: "We noticed some unusual activity" (nothing was charged). The rest of the queue was stopped. Let Flow rest for a while, make one generation by hand in the Flow window, and only queue again once that works.';

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

// `detailed` opens the account panel to read the balance, so it must not run while a generation is driving the page.
export async function getFlowState(detailed = false): Promise<FlowState> {
  const page = await getFlowPage();
  const url = page.url();
  // Signed-out visitors are bounced to the marketing page or Google's sign-in.
  const signedIn = !/\/about|accounts\.google\.com/.test(url);
  const inProject = /\/project\//.test(url);
  const state: FlowState = { url, signedIn, inProject };
  if (signedIn && inProject) {
    state.project =
      (await page.getByRole("heading", { level: 1 }).first().innerText({ timeout: 1500 }).then((t) => t.trim(), () => undefined)) ||
      (await page.getByRole("textbox", { name: "Editable text" }).first().inputValue({ timeout: 1000 }).then((t) => t.trim(), () => undefined)) ||
      (await page.title().then((t) => t.replace(/^Google Flow\s*[-–]\s*/, "").trim() || undefined, () => undefined));
  }
  if (!signedIn) state.hint = "Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.";
  else if (!inProject) {
    const names = await listProjects(page).then((p) => p.map((x) => x.name), () => []);
    state.projects = names;
    state.hint = names.length
      ? `Signed in, but no project is open. Call flow_open_project with one of: ${names.join(" | ")}.`
      : "Signed in, but no project is open. Open or create a project in the Flow Chrome window.";
  } else if (detailed) {
    state.plan = await page.getByRole("button", { name: "Account details" }).innerText().then((t) => t.trim().split("\n")[0], () => undefined);
    state.credits_remaining = await readCredits(page).catch(() => undefined);
    state.composer = await settingsTrigger(page).innerText().then((t) => t.replace(/\s+/g, " ").trim(), () => undefined);
  }
  return state;
}

// The projects page (flow.google.com itself) is `flow-projects-page` > `flow-projects-grid` > `flow-project-card`
// (mapped live 2026-10-22). A card's only link is `a[aria-label="Open project"]` with href /project/<uuid>, and the
// name is the card's first line of innerText (the rest is "edit" and "delete", the Material icon ligatures - the
// same trap as listCharacters).
const PROJECT_CARD = "flow-project-card";

export interface FlowProject {
  name: string;
  id: string;
  url?: string;
  current?: boolean;
}

async function readProjectsOnPage(target: Page): Promise<FlowProject[]> {
  await target.locator(`${PROJECT_CARD}, a[href*="/project/"]`).first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  await pause(target, 1500);
  return target.evaluate((sel) => {
    const seen = new Set<string>();
    const out: { name: string; id: string }[] = [];
    for (const card of document.querySelectorAll(sel)) {
      const id = card.querySelector('a[href*="/project/"]')?.getAttribute("href")?.match(/[0-9a-f-]{36}/)?.[0];
      const name = ((card as HTMLElement).innerText || "").split(String.fromCharCode(10))[0].trim();
      if (id && name && !seen.has(id)) {
        seen.add(id);
        out.push({ name, id });
      }
    }
    if (out.length) return out;
    // Fallback if Flow renders project links without the flow-project-card wrapper.
    const skip = new Set(["", "Edit project title", "Delete project", "Open project"]);
    for (const a of Array.from(document.querySelectorAll('a[href*="/project/"]'))) {
      const id = a.getAttribute("href")?.match(/\/project\/([0-9a-f-]{36})/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let card: Element = a;
      while (card.parentElement && card.parentElement.querySelectorAll('a[href*="/project/"]').length === 1) card = card.parentElement;
      const lines = ((card as HTMLElement).innerText ?? "").split("\n").map((l) => l.trim());
      out.push({ id, name: lines.find((l) => !skip.has(l)) ?? id });
    }
    return out;
  }, PROJECT_CARD);
}

// Lists projects from Flow's home page. When `spareTab` is true (or when called while a project is open via
// flow_projects), reads them in a temporary tab and always closes it so the working project tab is not disturbed.
export async function listProjects(page: Page, opts: { spareTab?: boolean } = {}): Promise<FlowProject[]> {
  if (opts.spareTab) {
    const tab = await page.context().newPage();
    try {
      await tab.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
      return await readProjectsOnPage(tab);
    } finally {
      await tab.close().catch(() => {});
    }
  }
  if (/\/project\//.test(page.url())) {
    await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
    await pause(page, 2500);
  }
  return readProjectsOnPage(page);
}

// Lists the account's projects without disturbing the open project tab, marking which one is currently open.
export async function listProjectsSummary(): Promise<{ projects: (FlowProject & { url: string; current: boolean })[]; current?: string }> {
  const state = await getFlowState();
  if (!state.signedIn) throw new Error(state.hint);
  const page = await getFlowPage();
  const here = page.url().match(/\/project\/([0-9a-f-]{36})/)?.[1];
  const found = await listProjects(page, { spareTab: /\/project\//.test(page.url()) });
  const projects = found.map((p) => ({ name: p.name, id: p.id, url: `https://flow.google.com/project/${p.id}`, current: p.id === here }));
  return { projects, current: projects.find((p) => p.current)?.name };
}

// Opens a project by name, so a run can recover on its own instead of telling the user to click. A uuid or a full
// project URL is taken as given. Matching is exact first, then case-insensitively on the start of the name, and an
// ambiguous name is refused rather than guessed - picking the wrong project would generate into someone else's work.
export async function openProject(wanted: string): Promise<FlowProject & { url: string }> {
  const state = await getFlowState();
  if (!state.signedIn) throw new Error(state.hint);
  const page = await getFlowPage();

  // Whatever happens, a failure puts the window back where it was.
  const wasAt = page.url();
  const restore = async () => {
    if (/\/project\//.test(wasAt) && page.url() !== wasAt) {
      await page.goto(inEnglish(wasAt), { waitUntil: "domcontentloaded" }).catch(() => {});
      await pause(page, 1500);
    }
  };

  const direct = wanted.match(MEDIA_UUID_RE)?.[0];
  let project: FlowProject | undefined;
  if (direct) project = { name: wanted, id: direct };
  else {
    const all = await listProjects(page, { spareTab: /\/project\//.test(wasAt) }).catch(async (err) => {
      await restore();
      throw err;
    });
    const fail = async (message: string): Promise<never> => {
      await restore();
      throw new Error(message);
    };
    if (!all.length) await fail("Flow shows no projects to open. Create one in the Flow Chrome window.");
    const exact = all.filter((p) => p.name === wanted);
    const starts = all.filter((p) => p.name.toLowerCase().startsWith(wanted.toLowerCase()));
    const hits = exact.length ? exact : starts;
    if (!hits.length) await fail(`No project called "${wanted}". Flow has: ${all.map((p) => p.name).join(" | ")}.`);
    if (hits.length > 1)
      await fail(`${hits.length} projects start with "${wanted}": ${hits.map((p) => p.name).join(" | ")}. Use the full name.`);
    project = hits[0];
  }

  const url = `https://flow.google.com/project/${project.id}`;
  await page.goto(inEnglish(url), { waitUntil: "domcontentloaded" });
  await pause(page, 2500);
  await ensureEnglish(page);
  if (!/\/project\//.test(page.url())) {
    const landed = page.url();
    await restore();
    throw new Error(`Flow did not open ${project.name} (ended up at ${landed}).`);
  }
  // The name is only known for sure once the project is open: a uuid was passed in as its own name.
  const open = direct ? (await page.title().catch(() => "")).replace(/^Google Flow\s*[-–]\s*/, "").trim() || project.name : project.name;
  return { name: open, id: project.id, url: page.url() };
}

// Flow's "Rights to use this image" agreement opens over everything after an upload and survives Escape, so every
// later job timed out behind it looking for some other button (2026-10-13). Agreeing is the user's call, never ours:
// stop with a message that says exactly what to click.
async function failOnRightsDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog").filter({ hasText: "Rights to use this image" });
  if (await dialog.isVisible().catch(() => false)) {
    throw new Error(
      'Flow is asking you to confirm "Rights to use this image" (shown once, on the first upload). Read it in the Flow Chrome window and click I agree or Cancel there, then run this again. Nothing was generated.',
    );
  }
}

// Menus close on Escape; the account panel does not and needs its own close button.
async function dismissOverlays(page: Page): Promise<void> {
  await failOnRightsDialog(page);
  await leaveSideMenu(page);
  await page.keyboard.press("Escape");
  const closePanel = page.getByRole("button", { name: "Close account panel" });
  if (await closePanel.isVisible().catch(() => false)) await closePanel.click({ timeout: 5000 }).catch(() => {});
  await clearBackdrops(page);
}

// Some of Flow's menus ignore Escape (the agent's model menu did, 2026-10-13), and the invisible backdrop behind an
// open menu ("cdk-overlay-backdrop settings-menu-backdrop") then swallows every click on the page: that is how an agent
// batch failed with "Could not switch Agent mode on". Clicking the backdrop is how such a menu closes, picking nothing.
async function clearBackdrops(page: Page): Promise<void> {
  const showing = page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  for (let i = 0; i < 4 && (await showing.count().catch(() => 0)); i++) {
    await showing.last().click({ force: true, timeout: 4000 }).catch(() => {});
    await pause(page, 500);
  }
}

// Flow renamed its agent toggle across UI revisions: "Agent" -> "Flow Agent" (770e001) and a switch/button whose
// accessible name says what a click will do ("Turn on Flow Agent" / "Turn off Flow Agent", PR #38). Match any of
// those without matching "Agent instructions" or "Agent settings", and read state via ARIA or label.
function agentToggle(page: Page) {
  return page
    .getByRole("button", { name: AGENT_BUTTON_RE })
    .or(page.getByRole("switch", { name: AGENT_SWITCH_RE }))
    .first();
}
async function agentIsOn(page: Page): Promise<boolean | null> {
  const t = agentToggle(page);
  // The composer is drawn a moment after the grid, so "not visible right now" is not yet "there is none": read too
  // early, agent mode that was ON looked like no toggle at all and the prompt went to the agent. The toggle gets a
  // few seconds to show. With "Settings trigger" already on the page the composer has been drawn, so a short wait is
  // enough to tell the variant that has no toggle (issue #43) without sitting out the long one.
  if (!(await t.isVisible().catch(() => false))) {
    const drawn = await settingsTrigger(page).isVisible().catch(() => false);
    if (!(await t.waitFor({ state: "visible", timeout: drawn ? 1500 : 6000 }).then(() => true, () => false))) return null;
  }
  const ariaPressed = await t.getAttribute("aria-pressed", { timeout: 3000 }).catch(() => null);
  const ariaChecked = ariaPressed === null ? await t.getAttribute("aria-checked", { timeout: 3000 }).catch(() => null) : null;
  const label =
    ariaPressed === null && ariaChecked === null
      ? (await t.getAttribute("aria-label", { timeout: 3000 }).catch(() => null)) ?? (await t.innerText({ timeout: 3000 }).catch(() => ""))
      : null;
  return classifyAgentToggleState({ ariaPressed, ariaChecked, label });
}

// A project can open with the agent docked on the right as a side panel ("Untitled session", with a Close button whose
// icon ligature text is right_panel_close; issues #42 and #24 comment 2). While it is open, the composer has no Agent
// toggle at all; closing it restores the bottom bar and toggle.
async function closeAgentSidePanel(page: Page): Promise<void> {
  if (await agentToggle(page).isVisible().catch(() => false)) return;
  const side = page.getByRole("button", { name: "Close", exact: true }).filter({ hasText: "right_panel_close" }).first();
  if (await side.isVisible().catch(() => false)) {
    await side.click({ timeout: 5000 }).catch(() => {});
    await pause(page, 1200);
  }
}

// The agent's own image model: the one the job names, else the user's saved default, else the newest Nano Banana, like
// single images. Best effort: a batch never fails over it. Since 2026-11-21 it is a radio group "Model" inside the
// "Image defaults" sub-panel (radios "🍌 Nano Banana 2.1" ...).
async function pickAgentImageModel(page: Page, model?: string): Promise<void> {
  const radios = page.locator("flow-agent-panel").getByRole("radiogroup", { name: "Model" }).getByRole("radio");
  if (!(await radios.first().isVisible().catch(() => false))) return;
  const names = (await radios.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""))).map((t) => t.replace(/\s+/g, " ").trim());
  const wanted = imageModelFor(model);
  const named = wanted === LATEST_IMAGE_MODEL ? -1 : names.findIndex((n) => matchesModelLabel(n, wanted));
  const index = named >= 0 ? named : newestNanoBanana(names);
  if (index >= 0 && !(await radios.nth(index).isChecked().catch(() => true))) await radios.nth(index).click({ timeout: 4000 }).catch(() => {});
  await pause(page, 400);
}

// The agent settings panel replaces the composer, hiding the Agent button. Back leaves it; since 2026-11-21 the defaults
// sit one level deeper ("Image defaults"), so it can take two Backs. Changes there save as they are made.
async function closeAgentSettings(page: Page): Promise<void> {
  const back = page.locator("flow-agent-panel").getByRole("button", { name: "Back", exact: true });
  for (let i = 0; i < 3 && (await back.isVisible().catch(() => false)); i++) {
    await clearBackdrops(page);
    await back.click({ timeout: 5000 }).catch(() => {});
    await pause(page, 800);
  }
}

// The balance only shows inside the account panel. That panel also holds "Sign out": never touch anything else in it.
async function readCredits(page: Page): Promise<number | undefined> {
  await dismissOverlays(page);
  await scrollToTop(page);
  await page.getByRole("button", { name: "Account details" }).click({ timeout: 5000 });
  const link = page.getByRole("link", { name: /Google Flow credits/ });
  try {
    await link.waitFor({ state: "visible", timeout: 5000 });
    const n = Number((await link.innerText()).replace(/[^\d]/g, ""));
    return Number.isNaN(n) ? undefined : n;
  } finally {
    await dismissOverlays(page);
    await pause(page, 300);
  }
}

const settingsTrigger = (page: Page) => page.getByRole("button", { name: "Settings trigger" });

// A tile's identity is the media inside it, and nothing else. Images carry a uuid in data-media-id; other tiles carry
// one in the media URL when Flow serves it as flow-content.google/<kind>/<uuid> (2026-10-21). New video tiles are
// also served on signed flow.google.com/asb/<token> links with no uuid anywhere (2026-11-01), so the asb token is the
// identity there (identical across reload, rename and hover swap from <img> to <video>; any "=..." suffix is dropped).
// A rendering tile already carries its final title (2026-10-09) and an error tile carries one too (2026-10-11),
// so neither counts as media until it is done.
//
// There used to be a fallback: an id-less tile was identified by its TITLE. That cost real work on 2026-10-21.
// Flow reuses its own auto titles, so two portraits of one batch both came back "Man posing for portrait" and
// shared one identity; the second looked like a tile we already knew, and the job went on to rename and download
// two unrelated frames from another clip instead.
const TILE_ID_JS = `(tile) => {
  if (tile.querySelector("flow-collection-tile, flow-pending-tile, flow-error-tile")) return undefined;
  const withId = tile.querySelector("[data-media-id]");
  if (withId) return withId.getAttribute("data-media-id") || undefined;
  // Order matters: a video tile at rest holds only its thumbnail <img>, and gains a <video> with a DIFFERENT uuid
  // once it plays, so the thumbnail is read first and the tile keeps one id either way.
  const media = tile.querySelector("img[src]") || tile.querySelector("video[src]");
  const src = media?.getAttribute("src") || "";
  return src.match(new RegExp(${JSON.stringify(MEDIA_UUID_RE.source)}))?.[0] || src.match(new RegExp(${JSON.stringify(ASB_TOKEN_RE.source)}))?.[1] || undefined;
}`;

// What the grid looked like before a job started: the media uuids of the tiles mounted at the top, plus the titles
// of the few older video tiles that still have no uuid at all. The titles are only ever used to recognise a tile
// that was already there - never to identify a new one.
export async function mediaIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (js) =>
      [...document.querySelectorAll("flow-grid-tile-container")].flatMap((t) => {
        const id = (eval(js) as (t: Element) => string | undefined)(t);
        if (id) return [id];
        const name = t.getAttribute("aria-label");
        return name ? ["title:" + name] : [];
      }),
    TILE_ID_JS,
  );
}

type MediaKind = "image" | "video";

interface GridWalk {
  fresh: { id: string; kind: string; label: string }[];
  pending: string[];
  errors: number;
  sawKnown: boolean;
}

// One walk down from the top of the grid, shared by everything that asks "what is new?". The grid is VIRTUALISED -
// a 97-tile project mounts about 33 tiles at the top - so "an id that was not in my snapshot" proves nothing: a
// download that scrolls mounts old tiles, and they then look fresh. What is reliable is the ORDER: Flow puts a new
// tile first. So the walk stops at the first tile we already knew, and only what is above it is new.
// Passed as a real function to page.evaluate (not an eval'd template string) so regex escapes like /\d+%/ stay intact.
async function walkNewTiles(page: Page, known: Iterable<string>): Promise<GridWalk> {
  return page.evaluate(
    ([ids, idJs]: [string[], string]) => {
      const seen = new Set(ids);
      const idOf = eval(idJs) as (t: Element) => string | undefined;
      const fresh: { id: string; kind: string; label: string }[] = [];
      const pending: string[] = [];
      let errors = 0;
      for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
        const id = idOf(tile);
        if (id && seen.has(id)) return { fresh, pending, errors, sawKnown: true };
        // A tile with no media id (a failed one, one still rendering, a collection) is in the snapshot under its
        // title. It has to be recognised here, before anything is counted: a failed tile left over from an earlier
        // job sits at the top of the grid, and counted as a new failure it got Flow's Retry pressed on it, which
        // re-runs the OLD prompt, or failed the new job outright.
        const name = tile.getAttribute("aria-label");
        if (!id && name && seen.has("title:" + name)) return { fresh, pending, errors, sawKnown: true };
        if (tile.querySelector("flow-error-tile")) {
          errors++;
          continue;
        }
        const text = (tile as HTMLElement).innerText || "";
        const pct = text.match(/\d+%/);
        const isVideo = !!tile.querySelector("flow-video-tile");
        const busy = !!pct || (isVideo && !tile.querySelector('img[alt="Generated video thumbnail"], video'));
        if (busy) {
          if (pct) pending.push(pct[0]);
          continue;
        }
        if (id) {
          fresh.push({
            id,
            kind: isVideo ? "video" : tile.querySelector("flow-image-tile") ? "image" : "other",
            label: tile.getAttribute("aria-label") || "",
          });
        }
      }
      return { fresh, pending, errors, sawKnown: false };
    },
    [[...known], TILE_ID_JS] as [string[], string],
  );
}

// The ids of tiles above the snapshot that really are this job's output: not one of our own uploads, and of the
// kind asked for.
function ownTiles(walk: GridWalk, kind?: MediaKind): string[] {
  return [...new Set(walk.fresh.filter((t) => !t.label.startsWith("fm-") && (!kind || t.kind === kind)).map((t) => t.id))];
}

export async function freshMedia(page: Page, before: string[], kind?: MediaKind): Promise<string[]> {
  return ownTiles(await walkNewTiles(page, before), kind);
}

// The grid is virtualised and the top bar hides once it is scrolled, so every step starts from the top,
// where new tiles appear.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0)));
  await pause(page, 400);
}

// Titles survive re-scans; the signed thumbnail URL used as a fallback handle does not (Flow re-signs it), so
// anything that has to find the same tile again should go through here.
const tileOf = (page: Page, asset: FlowAsset) =>
  asset.name
    ? page.locator(`flow-grid-tile-container[aria-label="${cssAttrValue(asset.name)}"]`).first()
    : mediaTile(page, asset.id!);

// A media id, and only a media id: whatever this returns is the tile that actually holds that piece of media.
const mediaTile = (page: Page, id: string) => {
  const safeId = cssAttrValue(id);
  return page.locator(`flow-grid-tile-container:has([data-media-id="${safeId}"]), flow-grid-tile-container:has([src*="${safeId}"])`).first();
};

// A failed generation becomes a <flow-error-tile> ("Failed ... You have not been charged") with Flow's own Retry
// button. Old failures can sit anywhere in the grid, so only error tiles above the first already-known tile count.
export async function newErrorTiles(page: Page, known: Iterable<string>): Promise<number> {
  return (await walkNewTiles(page, known)).errors;
}

// Flow says WHY on the tile (".error-message-text"): a busy server, or a policy refusal such as "This prompt might
// violate our policies about generating prominent people". The second never succeeds on retry, so it must not be
// retried and the user must see Flow's own words, not a generic "failed".
async function errorReason(page: Page): Promise<string> {
  return page
    .locator("flow-grid-tile-container flow-error-tile")
    .first()
    .evaluate((el) => ((el.querySelector(".error-message-text") as HTMLElement | null)?.innerText || (el as HTMLElement).innerText).replace(/\s+/g, " ").trim())
    .catch(() => "");
}
const POLICY = /polic|violat|prominent|safety|not allowed|guideline/i;

// Flow's Retry replaces the failed tile with a fresh render of the same prompt and settings, free of charge.
// Tiles produced by Agent mode only offer Delete, so the button may not be there at all.
async function retryErrorTile(page: Page, tile: Locator): Promise<boolean> {
  await hoverTile(page, tile);
  const retry = tile.getByRole("button", { name: "Retry" });
  if (!(await retry.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await retry.click({ timeout: 10_000 });
  await pause(page, 1500);
  await scrollToTop(page);
  return true;
}

// Big batches put more new tiles in the grid than Flow renders at once, so this walks down from the top, pressing
// Retry on every failed tile it meets, until it reaches a tile that existed before the job (or the end of the grid).
// Agent-mode failures offer no Retry button; the walk then stops and reports what it counted.
export async function retryNewErrorTiles(
  page: Page,
  known: Iterable<string>,
  dryRun = false,
): Promise<{ errors: number; reachedKnown: boolean; retried: number }> {
  const ids = [...known];
  let errors = 0;
  let retried = 0;
  let reachedKnown = false;
  let retryable = true;
  for (let pass = 0; pass < 80; pass++) {
    await scrollToTop(page);
    let found = false;
    for (let step = 0; step < 60 && !found && !reachedKnown; step++) {
      const state = await page.evaluate(([known, js]: [string[], string]) => {
        const seen = new Set(known);
        for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
          const id = (eval(js) as (t: Element) => string | undefined)(tile);
          const name = tile.getAttribute("aria-label");
          // "title:<name>" is how a snapshot records a tile with no uuid; a bare name is what the agent batch passes.
          if ((id && seen.has(id)) || (name && (seen.has(name) || seen.has("title:" + name)))) return "known";
          if (tile.querySelector("flow-error-tile")) return /unusual activity/i.test((tile as HTMLElement).innerText) ? "blocked" : "error";
        }
        return "none";
      }, [ids, TILE_ID_JS] as [string[], string]);
      if (state === "known") reachedKnown = true;
      else if (state === "blocked") throw new Error(BLOCKED_ERROR);
      else if (state === "error") {
        found = true;
        errors++;
        if (dryRun) break;
        retryable = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
        if (!retryable) break;
        retried++;
      } else {
        const moved = await page.evaluate(() => {
          const el = document.querySelector(".page-container");
          if (!el) return false;
          const top = el.scrollTop;
          el.scrollTop = top + el.clientHeight * 0.8;
          return el.scrollTop > top;
        });
        if (!moved) reachedKnown = true;
        await pause(page, 400);
      }
    }
    // A successful Retry reshuffles the grid (the new render jumps to the top), so the walk starts again.
    if (!found || dryRun || !retryable) break;
  }
  await scrollToTop(page);
  return { errors, reachedKnown, retried };
}

// Returns the media ids of the tiles this job just made - nothing else. A tile only counts when it sits ABOVE a
// tile that was already in the snapshot, so a stranger the virtualised grid happened to mount can never be mistaken
// for ours. If no such tile ever appears, this times out and says so, which is the honest answer: on 2026-10-21 the
// old rule instead handed back two frames from another clip, which were then renamed and downloaded over the job's
// real output.
async function waitForNewMedia(page: Page, before: string[], count: number, timeoutMs: number, job?: Job, kind?: MediaKind): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const emptyGrid = before.length === 0;
  let retriesLeft = job?.params.retries ?? 1;
  let failures = 0;
  while (Date.now() < deadline) {
    await pause(page, 2000);
    // The walk only means anything read from the top: scrolled down, the first tile in the DOM is an old one, and
    // one that was outside the snapshot's window would be taken for new. Re-asserting the top costs nothing.
    await scrollToTop(page);
    const walk = await walkNewTiles(page, before);
    const fresh = ownTiles(walk, kind);
    // Without a known tile below them there is no proof these are new - unless the project really was empty.
    const trustworthy = walk.sawKnown || emptyGrid;
    if (trustworthy && fresh.length >= count) return fresh.slice(0, count);
    if (job) job.progress = walk.pending.join(", ") || undefined;
    const errors = walk.pending.length ? 0 : walk.errors;
    if (!errors) continue;
    // Only the newest failure counts: old refusals stay in the grid forever.
    if (BLOCKED_TEXT.test((await page.locator("flow-error-tile").first().innerText().catch(() => "")) ?? "")) {
      throw new Error(BLOCKED_ERROR);
    }
    failures += errors;
    const reason = await errorReason(page);
    if (POLICY.test(reason)) {
      const hint = /prominent|public figure|celebrit/i.test(reason)
        ? " Flow thinks a face in this scene looks like a real, well-known person, usually one from an uploaded photo or a character made from one. Retrying will not change that: use a character drawn from a description (flow_character with `describe`) instead."
        : " Retrying the same prompt will not change that.";
      throw new Error(`Flow refused this generation on policy grounds: "${reason}" Nothing was charged.${hint}`);
    }
    if (retriesLeft > 0) {
      retriesLeft--;
      if (job) job.progress = "Flow failed, retrying";
      const retried = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
      if (retried) continue;
    }
    if (trustworthy && fresh.length) return fresh;
    throw new Error(`Flow failed this generation ${failures} time(s) ("${reason || "Sorry, this image/video failed to generate"}"). Nothing was charged. Try again later or reword the prompt.`);
  }
  throw new Error(
    `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow to finish. Nothing was renamed or downloaded. ` +
      `If Flow did produce it, the media is in the project under Flow's own title and flow_download fetches it without spending credits again.`,
  );
}

async function openSettings(page: Page): Promise<void> {
  const probe = page.getByRole("radio", { name: "Image", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await probe.isVisible().catch(() => false)) return;
    await settingsTrigger(page).click();
    await probe.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await probe.isVisible().catch(() => false))) throw new Error("Could not open Flow's generation settings popover.");
}

async function pickRadio(page: Page, name: string | RegExp): Promise<void> {
  const radio = page.getByRole("radio", { name, exact: typeof name === "string" }).first();
  // The Escape that closes the model menu when no model change is needed can close the whole settings popover with
  // it (a brand-new project already on the newest Nano Banana: "Flow has no "x2" option"), so reopen it and look again.
  if (!(await radio.isVisible().catch(() => false))) await openSettings(page).catch(() => undefined);
  if (!(await radio.isVisible().catch(() => false))) {
    // Name what the popover did offer, so a missing option explains itself next time.
    const offered = await page
      .getByRole("radio")
      .evaluateAll((rs) => rs.map((r) => (r.getAttribute("aria-label") || r.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean))
      .catch(() => [] as string[]);
    throw new Error(`Flow has no "${name}" option for the current mode/model. ${offered.length ? `It offered: ${offered.join(" | ")}` : "The settings popover was not open."}`);
  }
  if (!(await radio.isChecked())) {
    await radio.click();
    await pause(page, 500);
  }
}

// Image jobs use the newest Nano Banana unless another model is named (the user's call, 2026-10-13: "should always
// default to latest"). The menu then held Nano Banana Pro, 2 Lite and 2.1 - the plain "Nano Banana 2" was gone, and
// asking for it by name picked whichever came first. The newest is the highest version number that is not a Lite model,
// read from Flow's own menu, so a later 2.2 or 3 is picked with no code change.
export const LATEST_IMAGE_MODEL = "latest";
const LEGACY_IMAGE_MODEL = /^\s*(nano banana( 2)?|latest)?\s*$/i;
// The model an image job uses: the one it names, else the default the user saved (flow_image_models), else the newest.
export const imageModelFor = (model?: string): string => {
  const wanted = model ?? defaultImageModel();
  return LEGACY_IMAGE_MODEL.test(wanted ?? "") ? LATEST_IMAGE_MODEL : wanted!;
};
export function newestNanoBanana(names: string[]): number {
  const version = (n: string) => /nano banana\s+(\d+(?:\.\d+)*)/i.exec(n)?.[1]?.split(".").map(Number);
  let best = -1;
  names.forEach((n, i) => {
    const v = version(n);
    if (!v || /\blite\b/i.test(n)) return;
    const b = best < 0 ? undefined : version(names[best])!;
    const newer = !b || v.some((x, k) => x !== (b[k] ?? 0) && v.slice(0, k).every((y, j) => y === (b[j] ?? 0)) && x > (b[k] ?? 0));
    if (newer) best = i;
  });
  return best;
}

async function pickModel(page: Page, model: string): Promise<void> {
  const button = page.getByRole("button", { name: "Select model family" });
  const latest = model === LATEST_IMAGE_MODEL;
  if (!latest && matchesModelLabel(await button.innerText(), model)) return;
  await button.click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const index = latest ? newestNanoBanana(names) : names.findIndex((n) => matchesModelLabel(n, model));
  const shown = (await button.innerText()).replace(/\s+/g, " ");
  if (index < 0 || (latest && shown.includes(names[index]))) {
    // Nothing to change (already the newest, or no numbered Nano Banana here at all): close the menu, pick nothing.
    await page.keyboard.press("Escape");
    await clearBackdrops(page);
    if (index < 0 && !latest) throw new Error(`Model "${model}" not found. Available here: ${names.join(", ")}`);
    return;
  }
  await items.nth(index).click();
  await pause(page, 700);
}

// The image models this account's Flow offers, read from the composer's own model menu (Image mode), so the list is
// whatever Flow shows today rather than a list kept in code. Picks nothing: the menu and the popover are closed again.
export async function listImageModels(): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  await openSettings(page);
  try {
    await pickRadio(page, "Image");
    await page.getByRole("button", { name: "Select model family" }).click({ timeout: 5000 });
    const items = page.getByRole("menuitem");
    await items.first().waitFor({ state: "visible", timeout: 5000 });
    // Labels start with an emoji ("🍌 Nano Banana Pro", seen 2026-10-24) that the agent's own model menu may not
    // carry, so names are kept from the first letter or digit on; every lookup matches by matchesModelLabel/includes.
    return (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+/u, "").trim()).filter(Boolean);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
    await clearBackdrops(page).catch(() => {});
    await closeSettings(page).catch(() => {});
    await pause(page, 400);
  }
}

// Omni 1.1 Flash offers 4s/6s/8s/10s radios. Omni 1.2 Flash (2026-11-21) has a "Length" slider instead: an
// <input type=range> 0..12 that reads "Length 3 Sec" .. "Length 15 Sec" in the popover. The slider's own value is not
// in seconds, so it is moved by keys from its first step and the popover's own "<N> Sec" text is checked.
async function pickDuration(page: Page, seconds: number): Promise<void> {
  const slider = page.getByRole("slider", { name: "Length" });
  if (!(await slider.isVisible().catch(() => false))) return pickRadio(page, `${seconds}s`);
  const pane = page.locator(".cdk-overlay-pane:has(.credit-cost-label)").last();
  const shown = async () => Number(/Length\s*(\d+)\s*Sec/i.exec(await pane.innerText().catch(() => ""))?.[1] ?? NaN);
  await slider.focus();
  await page.keyboard.press("Home");
  await pause(page, 300);
  const min = await shown();
  const steps = Number(await slider.getAttribute("max")) - Number(await slider.getAttribute("min"));
  if (Number.isNaN(min) || seconds < min || seconds > min + steps) {
    throw new Error(`This model's clips run ${Number.isNaN(min) ? "a different range" : `${min} to ${min + steps} s`}; ${seconds} s is not one of them.`);
  }
  for (let i = 0; i < seconds - min; i++) await page.keyboard.press("ArrowRight");
  await pause(page, 500);
  if ((await shown()) !== seconds) throw new Error(`Flow's length slider did not land on ${seconds} s (it shows ${await shown()} s).`);
}

// Applies the scene settings and returns the credit cost Flow quotes for them.
// One Escape does not always shut the settings popover (2026-10-30: it stayed open after a run and its credit label
// swallowed the next click on the prompt box, so flow_character timed out). Check it is gone, and try again.
async function closeSettings(page: Page): Promise<void> {
  const popover = page.locator(".cdk-overlay-pane:has(.credit-cost-label)");
  for (let i = 0; i < 3; i++) {
    if (!(await popover.count())) return;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press("Escape");
    await pause(page, 400);
  }
  if (await popover.count()) await page.getByRole("button", { name: "Settings trigger" }).click({ timeout: 5000 }).catch(() => undefined);
}

async function applySettings(page: Page, job: Job): Promise<number> {
  const s = job.params;
  const framesMode = Boolean(s.first_frame || s.last_frame);
  await openSettings(page);
  await pickRadio(page, s.type === "image" ? "Image" : "Video");
  if (s.type === "video") await pickRadio(page, framesMode ? "Frames" : "Ingredients");
  if (s.aspect_ratio) await pickRadio(page, s.aspect_ratio);
  const model = s.type === "image" ? imageModelFor(s.model) : s.model;
  if (model) {
    await pickModel(page, model);
    // When the model was already right, closing its menu (Escape, then the backdrop) can shut the whole popover too:
    // the next image job on a second account then failed with "no x1 option ... popover was not open" (2026-10-24).
    await openSettings(page);
  }
  if (s.type === "video" && s.resolution) await pickRadio(page, new RegExp(`^${s.resolution}`));
  if (s.type === "video" && s.duration) await pickDuration(page, s.duration);
  await pickRadio(page, `x${s.variants ?? 1}`);
  await pause(page, 600);
  // The quote is "<N> credits". Low balances add an "Add AI credits" banner link that the old /credits?$/ also matched.
  const costText = await page.getByRole("link", { name: /^\d[\d,]*\s+credits?$/ }).first().innerText();
  const cost = Number(costText.match(/\d+/)?.[0] ?? NaN);
  await closeSettings(page);
  if (Number.isNaN(cost)) throw new Error(`Could not read the credit cost from Flow ("${costText}").`);
  return cost;
}

const ASSET_PREFIX = "asset:";

// Waits for THIS upload by its own name until Flow has finished processing it (its picture carries a media id), so
// a half-processed upload can never be taken for the next generation's result.
async function waitForUpload(page: Page, name: string, timeoutMs: number): Promise<void> {
  const tile = page.locator(`flow-grid-tile-container[aria-label="${cssAttrValue(name)}"]:has([data-media-id])`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tile.count()) {
      await pause(page, 1000);
      return;
    }
    // The first upload ever can stop at Flow's rights agreement; say so now rather than after the full timeout.
    await failOnRightsDialog(page);
    await pause(page, 1000);
  }
  throw new Error(`Flow did not finish processing the upload "${name}" within ${Math.round(timeoutMs / 1000)}s.`);
}

// Uploads under a unique filename so the asset can be picked unambiguously afterwards.
// "asset:<name>" refers to something already in the Flow project (image, video, character) and skips the upload.
async function uploadAsset(page: Page, job: Job, file: string, label: string): Promise<string> {
  if (file.startsWith(ASSET_PREFIX)) return file.slice(ASSET_PREFIX.length).trim();
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const name = `fm-${job.id}-${label}${extname(file).toLowerCase()}`;
  const work = workDir("flow-mcp-");
  const staged = join(work, name);
  copyFileSync(file, staged);
  try {
    await scrollToTop(page);
    await page.getByRole("button", { name: "Add media menu" }).click();
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.getByRole("menuitem", { name: "Upload", exact: true }).click();
    await (await chooser).setFiles(staged);
    await waitForUpload(page, name, 90_000);
    return name;
  } finally {
    // The copy was only ever needed for the upload; it used to be left behind, one per reference image.
    rmSync(work, { recursive: true, force: true });
  }
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Options read "<name>", "<name> Image|Video|Avatar" or "<voice> <description>", so match on the leading name.
const optionByName = (list: Locator, name: string) =>
  list.getByRole("option", { name: new RegExp(`^${escapeRe(name)}`, "i") }).first();

// The asset list is a cdk-virtual-scroll-viewport ("asset-list-viewport"): it holds about 15 of the project's
// assets in the DOM at a time out of a 3504px-tall list (mapped 2026-10-21). Waiting for an option that is simply
// not mounted yet is how three animations died on a 10 s timeout, while two frames with titles of exactly the same
// shape attached first time - the difference was only that they were among the newest.
const assetViewport = "cdk-virtual-scroll-viewport.asset-list-viewport";

// Finds the option wherever it is in the list: what is already mounted, then the panel's own "Search assets" box
// (it filters the whole project, not just the mounted window), then the viewport scrolled to the end.
async function findAssetOption(page: Page, list: Locator, assetName: string): Promise<Locator | null> {
  const option = optionByName(list, assetName);
  const visible = () => option.isVisible().catch(() => false);
  if (await visible()) return option;

  const search = page.getByPlaceholder("Search assets");
  if (await search.isVisible().catch(() => false)) {
    await search.fill(assetName);
    await pause(page, 1500);
    if (await visible()) return option;
    await search.fill("");
    await pause(page, 1000);
  }

  await page.evaluate((sel) => document.querySelector(sel)?.scrollTo({ top: 0 }), assetViewport);
  await pause(page, 500);
  for (let step = 0; step < 80; step++) {
    const moved = await page.evaluate((sel) => {
      const vp = document.querySelector(sel);
      if (!vp) return false;
      const top = vp.scrollTop;
      vp.scrollTop = top + vp.clientHeight * 0.8;
      return vp.scrollTop > top;
    }, assetViewport);
    await pause(page, 400);
    if (await visible()) return option;
    if (!moved) break;
  }
  return null;
}

// The frame pickers attach on click; the ingredients picker only previews and needs "Add to prompt".
// Option names are "<asset name>" or "<asset name> Image|Video", so match on the prefix.
export async function attachAsset(page: Page, opener: Locator, assetName: string): Promise<void> {
  const list = page.getByRole("listbox", { name: "Asset list" });
  const all = page.getByRole("tab", { name: "All", exact: true });
  const shows = (l: Locator, ms: number) => l.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
  // Twice on 2026-10-09 (a character, then an uploaded still) the click on the opener produced no picker at all, and
  // the job died waiting for it. It never reproduced when replayed, so it was something transient in the way - most
  // likely the upload menu still closing. Like the settings popover, the picker gets three tries, with Escape in
  // between to clear whatever caught the click. The Start/End frame pickers have no tabs, hence list OR All tab.
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    if (attempt) {
      await page.keyboard.press("Escape");
      await pause(page, 800);
    }
    await opener.click();
    opened = await Promise.race([shows(list, 5000), shows(all, 5000)]);
  }
  if (!opened) throw new Error(`Flow's media picker did not open (three tries) while attaching "${assetName}". Nothing was generated.`);
  // The picker reopens on whichever tab was used last (Characters, after a character), so start from All each time.
  if ((await all.isVisible().catch(() => false)) && (await all.getAttribute("aria-selected")) !== "true") {
    await all.click();
    await pause(page, 1000);
  }
  await list.waitFor({ state: "visible", timeout: 10_000 });
  // A search left over from a previous attach would hide everything, so the panel always starts unfiltered.
  // Short timeout on purpose: a picker without a search box must not cost 30 s of Playwright's default wait.
  const search = page.getByPlaceholder("Search assets");
  if (await search.inputValue({ timeout: 1500 }).catch(() => "")) {
    await search.fill("");
    await pause(page, 800);
  }
  let option = await findAssetOption(page, list, assetName);
  // Voices, characters and avatars live behind their own tabs, so look there when "All" does not have it.
  if (!option) {
    for (const tab of ["Voices", "Characters", "Avatars", "Uploads"]) {
      const t = page.getByRole("tab", { name: tab, exact: true });
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.click();
      await pause(page, 1200);
      option = await findAssetOption(page, list, assetName);
      if (option) break;
    }
  }
  if (!option) {
    // The ingredients picker leaves aria-label EMPTY and names its options through their text, so both are read.
    const offered = await list.getByRole("option").evaluateAll((os) => os.slice(0, 8).map((o) => (o.getAttribute("aria-label") || o.textContent || "").replace(/\s+/g, " ").trim()));
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `Flow's asset list has nothing starting with "${assetName}", after searching it and scrolling it to the end. Nothing was generated. Check the title with flow_assets, or pass an absolute file path instead. The list showed: ${offered.join(" | ") || "(empty)"}`,
    );
  }
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  const add = page.getByRole("button", { name: "Add to prompt", exact: true });
  const viaAdd = await add.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
  if (viaAdd) await add.click().catch(() => {});
  const closed = () => list.waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false);
  // A second reference once left the ingredients picker open after "Add to prompt" and the job died here
  // (2026-10-13). Press Add again, then Escape - only in the ingredients picker, where runGeneration counts the
  // attached chips afterwards and stops before spending anything. A frame picker is never escaped out of.
  if (!(await closed()) && viaAdd) {
    if (await add.isVisible().catch(() => false)) await add.click().catch(() => {});
    if (!(await closed())) await page.keyboard.press("Escape");
  }
  await list.waitFor({ state: "hidden", timeout: 5000 });
  await pause(page, 500);
}

async function typePrompt(page: Page, prompt: string): Promise<void> {
  const box = page.locator(".ProseMirror");
  await box.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  // Enter submits in Flow, so the prompt goes in as a single line.
  await page.keyboard.type(prompt.replace(/\s*\n+\s*/g, " ").trim(), { delay: 8 });
  await pause(page, 500);
}

export type DownloadQuality = "original" | "upscaled";

export async function downloadMedia(page: Page, mediaId: string, targetStem: string, quality: DownloadQuality = "original"): Promise<string[]> {
  // A tile that has just finished rendering is still settling and the grid re-renders around it, so give it a moment.
  await scrollToTop(page);
  await pause(page, 2500);
  const tile = mediaTile(page, mediaId);
  await tile.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error(
      `The finished file is in Flow but could not be found again in the grid${mediaId.startsWith("title:") ? ` (looked for "${mediaId.slice(6)}")` : ""}. ` +
        `Nothing is lost: flow_download fetches it by its title without spending credits again.`,
    );
  });
  // Grab the title NOW, while the id still resolves, so the download can re-find this exact tile later even if the
  // virtualised grid unmounts and remounts it between steps.
  const title = (await tile.getAttribute("aria-label").catch(() => null)) ?? undefined;
  return downloadTile(page, tileByIdOrTitle(page, mediaId, title), targetStem, quality);
}

type TileResolver = () => Promise<Locator>;

// Re-finds the tile on every attempt instead of trusting one handle that may have been unmounted by the virtual grid:
// by id first, then by title. NOT a confirmed root cause for the post-generation download failures - the failure has
// never reproduced on a settled tile - but it removes one whole class of staleness, and the menu dump below is what
// will actually explain the next one. An empty "Untitled Scene" placeholder holds no media and its menu has no
// Download, so :has([src]) makes sure we never grab one by title.
function tileByIdOrTitle(page: Page, id: string, title?: string): TileResolver {
  return async () => {
    const byId = mediaTile(page, id);
    if (await byId.count()) return byId;
    if (title) {
      const byTitle = page.locator(`flow-grid-tile-container[aria-label="${cssAttrValue(title)}"]:has([src])`).first();
      if (await byTitle.count()) return byTitle;
    }
    throw new Error(
      `The finished tile is no longer in the grid${title ? ` ("${title}")` : ""}. The media is still in Flow: flow_download fetches it without spending credits again.`,
    );
  };
}

// Each account's Chrome saves into its own folder ("main" keeps <HOME_DIR>/downloads).
const ownDownloads = () => downloadDir(currentAccount());

// Accounts run at the same time, but downloads take turns: a file that slips past the override lands in the shared
// ~/Downloads, and with two accounts downloading at once either watcher could claim the other's file. A download is a
// few seconds, so taking turns costs little.
let downloadTurn: Promise<unknown> = Promise.resolve();
function oneDownloadAtATime<T>(work: () => Promise<T>): Promise<T> {
  const mine = downloadTurn.then(work, work);
  downloadTurn = mine.catch(() => {});
  return mine;
}

// Download names Chrome announced on Flow's page, newest last, kept PER PAGE so two accounts cannot vouch for each
// other's files in ~/Downloads (see downloads.ts).
const announcedByPage = new WeakMap<Page, { name: string; at: number }[]>();
const listening = new WeakSet<Page>();
const downloadSessions = new WeakMap<Page, CDPSession>();

async function applyDownloadDir(cdp: CDPSession, dir: string): Promise<boolean> {
  const behaviour = { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true } as const;
  if (await cdp.send("Browser.setDownloadBehavior", behaviour).then(() => true, () => false)) return true;
  // Chrome 156 refuses the browser-wide call for the default context (issue #22); the older per-page call may still
  // be honoured on the same session, and if not, waitForDownloadedFile watches ~/Downloads with provenance checks.
  return cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).then(() => true, () => false);
}

// Playwright keeps a download in a per-connection temp file it can delete from under us; pointing Chrome itself at a
// directory we own makes the bytes ours the moment they land.
async function useOwnDownloadDir(page: Page): Promise<void> {
  // Setting this once per process was not enough: another CDP client attaching resets it browser-wide, and Chrome
  // quietly goes back to ~/Downloads. Every file we "could not download" tonight was sitting there the whole time,
  // so this is re-asserted before every single download, and again every two seconds while one is awaited: an
  // upscale takes minutes to start arriving, which left plenty of time for the setting to be reset in between.
  const dir = ownDownloads();
  mkdirSync(dir, { recursive: true });
  if (!listening.has(page)) {
    listening.add(page);
    const list: { name: string; at: number }[] = [];
    announcedByPage.set(page, list);
    page.on("download", (d) => {
      list.push({ name: d.suggestedFilename(), at: Date.now() });
      if (list.length > 50) list.shift();
    });
  }
  // One session per page, kept open and reused. Chrome puts the download folder back to its default when the session
  // that set it closes, so it is never detached; a new one is opened only when the old one has stopped answering.
  const open = downloadSessions.get(page);
  if (open && (await applyDownloadDir(open, dir))) return;
  const cdp = await page.context().newCDPSession(page);
  downloadSessions.set(page, cdp);
  await applyDownloadDir(cdp, dir);
}

// Everything already sitting in either folder, so a new arrival can be told apart from what was there before.
function downloadsNow(): DownloadWatch {
  return snapshotDownloads([ownDownloads(), SYSTEM_DOWNLOADS]);
}

// Waits for the file Flow is sending to finish arriving and returns it. It is looked for in our own download folder
// and, for when the override has been reset behind our back, in Chrome's own: there only a file proven to be Flow's
// is taken, never something else the user happened to download meanwhile.
async function waitForDownloadedFile(page: Page, before: DownloadWatch, timeoutMs: number): Promise<string> {
  const dir = ownDownloads();
  const deadline = Date.now() + timeoutMs;
  const settled = new SettledFiles();
  let reasserted = Date.now();
  while (Date.now() < deadline) {
    // Every quarter second: an image is there in well under a second, and a size that held still across two checks
    // still proves Chrome has finished writing it.
    await pause(page, 250);
    const announced = announcedByPage.get(page) ?? [];
    const names = announced.filter((a) => a.at >= before.since).map((a) => a.name);
    const candidates: { path: string; size: number }[] = [];
    for (const path of newDownloads(before, dir, SYSTEM_DOWNLOADS, names)) {
      try {
        candidates.push({ path, size: statSync(path).size });
      } catch {
        // gone again between the listing and the look
      }
    }
    const done = settled.next(candidates);
    if (done) return done;
    if (Date.now() - reasserted >= 2000) {
      reasserted = Date.now();
      await useOwnDownloadDir(page).catch(() => {});
    }
  }
  throw new Error(
    "Flow started the download but no file arrived in the tool's folder, and nothing new in ~/Downloads came from Flow. The media is still in Flow: flow_download fetches it again without spending credits.",
  );
}

// Flow reveals a tile's controls on a genuine pointer move, so the mouse is driven to the tile itself. It has to be a
// real MOVE: Chrome emits no pointermove when the pointer is asked to go where it already is, so a second attempt on
// the same tile hovered NOTHING, the toolbar never appeared, and the right-click fallback raised Chrome's own context
// menu over the <video> instead. That is how a finished paid clip failed to download three times running on
// 2026-11-04 while the same tile downloaded fine minutes later. The pointer is parked away from the tile first and
// then walked in over several steps, so every call is a movement the page can see.
async function hoverTile(page: Page, tile: Locator, settleMs = 900): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  if (box) {
    await page.mouse.move(4, 4);
    await pause(page, 120);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    await pause(page, settleMs);
  } else {
    await tile.hover();
    await pause(page, settleMs);
  }
}

// Chrome's "allowAndName" writes each download under a bare id with NO extension, so there is nothing to copy from
// the filename and everything was landing as .mp4 - including stills, which arrived as clip-01.mp4. Read the first
// bytes instead and name the file after what it actually is.
function extensionOf(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpeg";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return ".png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return ".mp4";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  // Flow hands back a ZIP when one tile holds several takes (a generation made at x2-x4): the takes come bundled.
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  // Anything else is unknown. Naming it .mp4 (the old fallback) made two ZIPs look like broken videos and broke a cut.
  return ".bin";
}

// Unpacks a multi-take ZIP into <stem>.mp4, <stem>-v2.mp4, ... - the same names a multi-variant generation gets - so
// every take is usable instead of one unplayable archive. The ZIP is kept beside them, renamed, in case it is wanted.
function unpackTakes(zip: string, targetStem: string): string[] {
  const work = workDir("flow-takes-");
  const takes = extractZip(zip, work).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out: string[] = [];
  for (const [i, path] of takes.entries()) {
    const dest = `${targetStem}${i ? `-v${i + 1}` : ""}${extensionOf(path)}`;
    moveFile(path, dest);
    out.push(dest);
  }
  moveFile(zip, `${targetStem}-takes.zip`);
  rmSync(work, { recursive: true, force: true });
  if (!out.length) throw new Error("Flow sent a ZIP with nothing usable inside it.");
  return out;
}

// ---- Collections: the whole batch in ONE download (mapped live 2026-11-07, the user's idea) ----------------------
// Left menu "Library" -> `Create collection` adds an entry to list "Collections" with a textbox "Rename item".
// Cmd+click (Ctrl elsewhere - not checked on a PC) selects grid tiles (an inner ".selected"); dragging one of them
// with the key still held drops the whole selection on a collection entry. That MOVES the images out of All media
// into the collection, which also shows in the grid as a <flow-collection-tile>. In the collection's own view
// (/project/<id>/collection/<uuid>) the top bar's `More options` has `Download collection`: one ZIP of the originals,
// each named "<title with _>_<first 8 characters of its media id>.jpg". 1 image came down in 1.2 s.
const SELECT_KEY = process.platform === "darwin" ? "Meta" : "Control";

export class CollectionError extends Error {}

const collectionEntry = (page: Page, name: string) =>
  page.getByRole("list", { name: "Collections" }).getByRole("button", { name, exact: true });

async function ensureCollection(page: Page, name: string): Promise<Locator> {
  const entry = collectionEntry(page, name);
  if (await entry.isVisible().catch(() => false)) return entry;
  if (await entry.count().catch(() => 0)) {
    // It exists but the Library section is folded away.
    await page.getByRole("button", { name: "Toggle library" }).click({ timeout: 4000 }).catch(() => {});
    await leaveSideMenu(page);
    await pause(page, 600);
    if (await entry.isVisible().catch(() => false)) return entry;
  }
  const create = page.getByRole("button", { name: "Create collection" });
  if (!(await create.isVisible().catch(() => false)))
    throw new CollectionError('Flow\'s left-hand menu shows no "Create collection" button, so the images could not be gathered into one download.');
  await create.click({ timeout: 5000 });
  const box = page.getByRole("textbox", { name: "Rename item" }).first();
  await box.waitFor({ state: "visible", timeout: 8000 }).catch(() => {
    throw new CollectionError("Flow made a collection but offered no name box for it.");
  });
  await box.fill(name);
  await box.press("Enter");
  await leaveSideMenu(page);
  await pause(page, 1000);
  if (!(await entry.isVisible().catch(() => false))) throw new CollectionError(`The new collection "${name}" does not show in Flow's left-hand menu.`);
  return entry;
}

const isSelected = (tile: Locator) => tile.locator(".selected").count().then((n) => n > 0, () => false);

async function selectClick(page: Page, tile: Locator): Promise<void> {
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  const box = await tile.boundingBox();
  if (!box) return;
  // Upper middle of the tile: clear of the hover buttons in the corners and the title along the bottom.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
  await pause(page, 120);
  await page.keyboard.down(SELECT_KEY);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up(SELECT_KEY);
  await pause(page, 220);
}

// Selects exactly these tiles (anything selected before is let go first) and returns the last one selected, which is
// on screen and becomes the drag handle.
async function selectTiles(page: Page, ids: string[]): Promise<string | undefined> {
  for (const tile of await page.locator("flow-grid-tile-container:has(.selected)").all()) {
    const id = await tile.evaluate((t, js) => (eval(js) as (t: Element) => string | undefined)(t), TILE_ID_JS).catch(() => undefined);
    if (!id || !ids.includes(id)) await selectClick(page, tile);
  }
  await scrollToTop(page);
  const left = new Set(ids);
  let last: string | undefined;
  for (let step = 0; step < 200 && left.size; step++) {
    for (const id of [...left]) {
      const tile = mediaTile(page, id);
      if (!(await tile.count())) continue;
      if (!(await isSelected(tile))) await selectClick(page, tile);
      if (await isSelected(tile)) {
        left.delete(id);
        last = id;
      }
    }
    if (!left.size) break;
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 700);
  }
  // The handle has to be on screen for the drag.
  if (last) await mediaTile(page, last).scrollIntoViewIfNeeded().catch(() => {});
  return last;
}

async function dragSelectionTo(page: Page, handle: string, entry: Locator): Promise<void> {
  const tile = await mediaTile(page, handle).boundingBox();
  const target = await entry.boundingBox();
  if (!tile || !target) throw new CollectionError("The images or the collection were not on screen for the drag.");
  const x = tile.x + tile.width / 2;
  const y = tile.y + tile.height * 0.4;
  await page.mouse.move(x, y);
  await page.keyboard.down(SELECT_KEY);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 8, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await pause(page, 500);
  await page.mouse.up();
  await page.keyboard.up(SELECT_KEY);
  await pause(page, 1500);
}

// Media ids inside the open collection view (small, but walked like the grid in case it is long).
async function idsInView(page: Page): Promise<Set<string>> {
  const ids = new Set<string>();
  await scrollToTop(page);
  for (let step = 0; step < 100; step++) {
    for (const id of await mediaIds(page)) ids.add(id);
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 600);
  }
  return ids;
}

async function openCollection(page: Page, name: string): Promise<void> {
  await ensureProjectGrid(page);
  const entry = await ensureCollection(page, name);
  await entry.click({ timeout: 5000 });
  await leaveSideMenu(page);
  await page.waitForURL(/\/collection\//, { timeout: 15_000 }).catch(() => {
    throw new CollectionError(`Flow did not open the collection "${name}".`);
  });
  await pause(page, 2500);
}

// In the collection's own view: top bar More options -> Download collection -> one ZIP.
function downloadOpenCollection(page: Page, timeoutMs: number): Promise<string> {
  return oneDownloadAtATime(() => downloadOpenCollectionNow(page, timeoutMs));
}

async function downloadOpenCollectionNow(page: Page, timeoutMs: number): Promise<string> {
  await useOwnDownloadDir(page);
  await page.mouse.move(2, 2); // no tile toolbar may be showing: tiles have their own "More options"
  // Flow hides its top bar once the grid is scrolled, and counting the collection scrolls it.
  await scrollToTop(page);
  await pause(page, 600);
  const before = downloadsNow();
  // The top bar's own button lives in <flow-more-options-menu>; every tile in the collection also carries a hidden
  // "More options", and .first() picked one of those once the collection held 20 (click timed out).
  await page.locator("flow-more-options-menu").getByRole("button", { name: "More options", exact: true }).first().click({ timeout: 8000 });
  const item = page.getByRole("menuitem", { name: "Download collection" });
  if (!(await item.waitFor({ state: "visible", timeout: 6000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new CollectionError('The collection\'s menu has no "Download collection".');
  }
  await item.click();
  const zip = await waitForDownloadedFile(page, before, timeoutMs).catch(() => {
    throw new CollectionError("Flow was asked for the collection's ZIP but no file arrived.");
  });
  if (extensionOf(zip) !== ".zip") throw new CollectionError(`Flow's collection download was not a ZIP (${extensionOf(zip)}).`);
  return zip;
}

// Unpacks a collection ZIP. With `wanted`, each image is saved as its stem (matched by the media id in its name);
// without, every image keeps its own name. Returns the saved files and the ids that were not in the ZIP.
function unpackCollection(zip: string, dir: string, wanted?: { id: string; stem: string }[]): { files: string[]; saved: Map<string, string> } {
  const work = workDir("flow-collection-");
  try {
    const entries = extractZip(zip, work);
    const files: string[] = [];
    const saved = new Map<string, string>();
    if (!wanted) {
      mkdirSync(dir, { recursive: true });
      for (const p of entries) {
        const dest = join(dir, basename(p, extname(p)).replace(/[^\w.-]+/g, "_") + extensionOf(p));
        copyFileSync(p, dest);
        files.push(dest);
      }
      return { files, saved };
    }
    const byId = new Map<string, string>();
    for (const p of entries) {
      const tag = basename(p, extname(p)).match(/_([0-9a-f]{8})$/)?.[1];
      if (tag) byId.set(tag, p);
    }
    for (const w of wanted) {
      const p = byId.get(w.id.slice(0, 8));
      if (!p) continue;
      const dest = `${w.stem}${extensionOf(p)}`;
      copyFileSync(p, dest);
      files.push(dest);
      saved.set(w.id, dest);
    }
    return { files, saved };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(zip, { force: true });
  }
}

// Moves these grid images into the collection `name` and fetches them all in one ZIP, each saved as its stem.
// Never falls back to another way of downloading (the user's rule: a failed step stops and says so): it throws a
// CollectionError naming where the images are.
export async function collectAndDownload(page: Page, job: Job | undefined, name: string, wanted: { id: string; stem: string }[]): Promise<Map<string, string>> {
  try {
    return await collectAndDownloadOnce(page, job, name, wanted);
  } catch (err) {
    // Any failure in here (a Playwright timeout included) is a download problem, never a reason to generate again.
    if (err instanceof CollectionError) throw err;
    await ensureProjectGrid(page).catch(() => {});
    throw new CollectionError(`Gathering the images into the collection "${name}" stopped: ${(err as Error).message.split("\n")[0]}`);
  }
}

async function collectAndDownloadOnce(page: Page, job: Job | undefined, name: string, wanted: { id: string; stem: string }[]): Promise<Map<string, string>> {
  const ids = wanted.map((w) => w.id);
  let inside = new Set<string>();
  // A collection made earlier in this batch may already hold some of them (they are no longer in All media then).
  await ensureProjectGrid(page);
  if (await collectionEntry(page, name).count().catch(() => 0)) {
    await openCollection(page, name);
    inside = await idsInView(page);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const todo = ids.filter((id) => !inside.has(id));
    if (!todo.length) break;
    await ensureProjectGrid(page);
    const entry = await ensureCollection(page, name);
    if (job) step(job, `selecting ${todo.length} image(s) for the collection`);
    const handle = await selectTiles(page, todo);
    if (!handle) throw new CollectionError(`None of the ${todo.length} image(s) could be selected in Flow's grid.`);
    if (job) step(job, `moving ${todo.length} image(s) into the collection "${name}"`);
    await dragSelectionTo(page, handle, entry);
    await openCollection(page, name);
    // the collection page lists images moved in during this visit only after a fresh load (same cause as the ZIP)
    await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
    await page.locator("flow-grid-tile-container").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    await pause(page, 2000);
    inside = await idsInView(page);
  }
  if (!page.url().includes("/collection/")) {
    await openCollection(page, name);
    inside = await idsInView(page);
  }
  const notMoved = ids.filter((id) => !inside.has(id));
  if (notMoved.length) {
    await ensureProjectGrid(page).catch(() => {});
    throw new CollectionError(
      `${notMoved.length} of ${ids.length} image(s) would not go into the collection "${name}"; they are still in All media. ` +
        `Nothing was downloaded one by one instead.`,
    );
  }
  // Flow builds the ZIP in the page from the images it has loaded, and one that has only just arrived can be left out
  // (2026-11-07: 1 of 2 missing, both there on the next try). So the ZIP is checked against the list and the
  // collection downloaded again for whatever is missing.
  // Which image becomes which file, written down first: if the download stops, downloadCollection can still name
  // every file after its scene instead of Flow's title.
  writeManifest(name, wanted);
  const saved = new Map<string, string>();
  let pending = wanted;
  const here = page.url();
  for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
    // The collection page only lists images moved in during this visit once it is loaded afresh: without a reload
    // its ZIP held 8 of 20 three times running; after one, all 20.
    if (attempt) await pause(page, attempt * 5000);
    await page.goto(inEnglish(here), { waitUntil: "domcontentloaded" });
    await page.locator("flow-grid-tile-container").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    await pause(page, 2500);
    if (job) step(job, `downloading the collection "${name}" as one ZIP${attempt ? ` (again, for ${pending.length} missing)` : ""}`);
    const zip = await downloadOpenCollection(page, 60_000 + ids.length * 3000);
    for (const [id, file] of unpackCollection(zip, "", pending).saved) saved.set(id, file);
    pending = pending.filter((w) => !saved.has(w.id));
  }
  await ensureProjectGrid(page).catch(() => {});
  if (pending.length)
    throw new CollectionError(`The collection "${name}" downloaded 4 times, but ${pending.length} of ${ids.length} image(s) were never in its ZIP.`);
  return saved;
}

const manifestDir = () => collectionsDir(currentAccount());
const manifestFile = (name: string) => join(manifestDir(), `${name.replace(/[^\w.-]+/g, "_")}.json`);

function writeManifest(name: string, wanted: { id: string; stem: string }[]): void {
  mkdirSync(manifestDir(), { recursive: true });
  const file = manifestFile(name);
  const old = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { id: string; stem: string }[]) : [];
  const merged = [...old.filter((o) => !wanted.some((w) => w.id === o.id)), ...wanted];
  writeFileSync(file, JSON.stringify(merged, null, 1));
}

// The whole collection in one ZIP. A collection made by an image batch is saved under the batch's scene names (its
// manifest says which image is which scene) in the batch's own folder; any other collection keeps Flow's titles in
// `dir`.
export async function downloadCollection(name: string, dir: string): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await openCollection(page, name);
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await pause(page, 3000);
  const zip = await downloadOpenCollection(page, 300_000);
  const manifest = existsSync(manifestFile(name)) ? (JSON.parse(readFileSync(manifestFile(name), "utf8")) as { id: string; stem: string }[]) : undefined;
  const out = unpackCollection(zip, dir, manifest);
  await ensureProjectGrid(page).catch(() => {});
  return out.files;
}

async function renameTileViaMenu(page: Page, tile: Locator, title: string): Promise<boolean> {
  await hoverTile(page, tile);
  const more = tile.getByRole("button", { name: "More options" });
  if (!(await more.isVisible().catch(() => false))) return false;
  await more.click();
  const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
  if (!(await rename.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await rename.click();
  await pause(page, 1200);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(title, { delay: 8 });
  await page.keyboard.press("Enter");
  await pause(page, 1500);
  return true;
}

// Flow titles clips itself and happily reuses a title: two takes of the same scene both came back as "Woman climbing
// granite wall", which makes a clip impossible to identify by name and cost real time tonight. Renaming each finished
// tile to our own scene name fixes it at the source - the user's suggestion, and the right one.
// The grid's More options -> Rename stopped saving (seen 2026-11-24: the name reverts on reload, even by hand), but
// renaming from the item's own page persists: open the tile, edit the title field there, press its Done button.
// The guard is the last line of defence under that: renaming a tile that already carries one of OUR names would wipe
// a name later steps rely on, which is exactly what happened on 2026-10-21, so it throws instead. It is off only for
// flow_rename, where putting such a name back is the whole point and the user has named the tile themselves.
async function renameTile(page: Page, tile: Locator, title: string, guard = true): Promise<boolean> {
  const existing = (await tile.getAttribute("aria-label").catch(() => null)) ?? "";
  if (guard && OUR_TITLE.test(existing)) {
    throw new Error(
      `Refusing to rename "${existing}" to "${title}": that title was given by this tool to an earlier asset, so this is not the tile the job just made. Nothing was renamed or downloaded.`,
    );
  }
  try {
    await hoverTile(page, tile);
    await tile.click();
    // Wait for navigation to the item's own /edit/ page BEFORE looking for "Editable text": the project grid itself
    // has a textbox named "Editable text" for the project title (createProject uses it), so a race here would rename
    // the entire Flow project instead of the tile.
    const openedEdit = await page.waitForURL(/\/edit\//, { timeout: 15_000 }).then(() => true, () => false);
    if (!openedEdit || !/\/edit\//.test(new URL(page.url()).pathname)) {
      // Never touch "Editable text" off /edit/. If we are still on the project grid with the same tile mounted, fall
      // back to that tile's own More options -> Rename menu.
      const onGrid = /^\/project\/[0-9a-f-]{36}\/?$/.test(new URL(page.url()).pathname);
      if (onGrid && (await tile.count().catch(() => 0)) > 0) return await renameTileViaMenu(page, tile, title);
      return false;
    }
    const box = page.getByRole("textbox", { name: "Editable text" });
    await box.waitFor({ state: "visible", timeout: 8000 });
    await box.click();
    await box.fill(title);
    await page.getByRole("button", { name: "Done", exact: true }).click({ timeout: 4000 });
    await pause(page, 1500);
    return true;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  } finally {
    await ensureProjectGrid(page).catch(() => {});
  }
}

function downloadTile(page: Page, target: Locator | TileResolver, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  return oneDownloadAtATime(() => downloadTileNow(page, target, targetStem, quality));
}

async function downloadTileNow(page: Page, target: Locator | TileResolver, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  await useOwnDownloadDir(page);
  const resolve: TileResolver = typeof target === "function" ? target : async () => target;
  let lastError: unknown;
  // Only fetching the file is retried. Once it has arrived, a failure to place it (a full or offline drive, a bad path)
  // must not trigger another download: that left three copies of every image in the download folder on 2026-10-21.
  let file: string | undefined;
  for (let attempt = 0; attempt < 3 && !file; attempt++) {
    try {
      const tile = await resolve();
      const before = downloadsNow();
      // Flow only shows a tile's toolbar for a real pointer move over it - Playwright's hover() does not trigger it.
      // The toolbar's "More options" beats a right-click, which can land on the <video> and raise Chrome's own menu.
      // 250 ms is the bulk-download pace; a tile that has only just finished rendering gets more room on each retry.
      await hoverTile(page, tile, attempt === 0 ? 250 : attempt === 1 ? 900 : 1500);
      const more = tile.getByRole("button", { name: "More options" });
      // isVisible() answers at once whatever timeout it is given, so wait for the button itself.
      if (await more.waitFor({ state: "visible", timeout: attempt ? 6000 : 3000 }).then(() => true, () => false)) await more.click();
      // Right-click is the last resort and never for a video: on a <video> it raises Chrome's OWN context menu, which
      // is browser UI the page cannot close, so it swallows the attempts that follow instead of failing cleanly.
      else if (attempt === 2 && (await tile.locator("video").count().catch(() => 1)) === 0) await tile.click({ button: "right" });
      else throw new Error("The tile's toolbar never appeared, so its menu could not be opened.");
      const download = page.getByRole("menuitem", { name: "Download", exact: true });
      if (!(await download.isVisible({ timeout: 8000 }).catch(() => false))) {
        // Saying what Flow actually offered turns "locator timed out" into something that explains itself next time.
        const items = await page.locator('[role="menuitem"]').evaluateAll((ms) => ms.map((m) => (m.textContent ?? "").replace(/\s+/g, " ").trim()));
        throw new Error(items.length ? `Flow's tile menu has no Download item. It offered: ${items.join(" | ")}` : "Flow's tile menu did not open.");
      }
      await download.click({ timeout: 10_000 });
      // Size submenu: "720p Original size" / "1K Original size", or the best free upscale the plan allows.
      const original = page.getByRole("menuitem", { name: /original/i }).first();
      if (await original.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
        const upscaled = page
          .locator('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])')
          .filter({ hasText: /upscaled/i })
          .filter({ hasText: FREE_UPSCALE })
          .first();
        const wanted = quality === "upscaled" && (await upscaled.isVisible().catch(() => false)) ? upscaled : original;
        await wanted.click();
      }
      // Upscales are rendered on demand, so they can take minutes to appear.
      file = await waitForDownloadedFile(page, before, quality === "upscaled" ? 600_000 : 180_000);
      await page.keyboard.press("Escape");
      await scrollToTop(page);
    } catch (err) {
      lastError = err;
      await page.keyboard.press("Escape").catch(() => {});
      await pause(page, 2000);
    }
  }
  if (!file) throw lastError;
  const kind = extensionOf(file);
  try {
    if (kind === ".zip") return unpackTakes(file, targetStem);
    const target = `${targetStem}${kind}`;
    moveFile(file, target);
    return [target];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Downloaded, but could not be saved to ${targetStem}${kind}: ${reason}. The file is safe at ${file}.`);
  }
}

// The left-hand "Project navigation" (All media, Images, Videos, Characters...). Its Collapse button (a setting Flow
// keeps for every project) turns it into a strip of icons with no labels, and getByText("Characters") then found
// nothing visible. Each item's text holds its icon name and its label whether or not the label shows, so it is found by
// label in both states. (Why the menu used to vanish altogether: see leaveSideMenu.)
async function clickProjectNav(page: Page, item: string): Promise<boolean> {
  const button = page
    .getByRole("navigation", { name: "Project navigation" })
    .locator("button, a")
    .filter({ hasText: new RegExp(`${item}\\s*$`) })
    .first();
  if (!(await button.isVisible().catch(() => false))) return false;
  await button.click({ timeout: 5000 }).catch(() => button.dispatchEvent("click", undefined, { timeout: 10_000 }));
  await leaveSideMenu(page);
  return true;
}

// The left-hand menu is a Material drawer, and Escape shuts it whenever the keyboard focus is inside it. Clicking
// "All media" left the focus there, so the very next Escape (dismissOverlays runs before almost every step) shut the
// menu for the rest of the session: the user's menu vanished, "All media" was hidden from then on, and each later click
// on it waited out Playwright's 30 s default (traced with DEBUG=pw:api, 2026-10-13). Take the focus out first.
async function leaveSideMenu(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest("mat-sidenav")) focused.blur();
    })
    .catch(() => {});
}
async function openProjectNav(page: Page, item: string): Promise<void> {
  if (await clickProjectNav(page, item)) return;
  // A page load shows the menu again in whatever state the user keeps it, and changes nothing about that choice.
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await pause(page, 3000);
  if (!(await clickProjectNav(page, item))) throw new Error(`Flow's left-hand menu is not showing, so "${item}" could not be opened. Show the menu in the Flow window and try again.`);
}

// All media: through the left-hand menu when it shows. When it does not (collapsed and scrolled away), the top bar's
// Filter menu does the same job: nothing ticked, newest first. `thorough` (the start of a job) checks that menu; a
// plain grid scan does not, so a hidden menu costs nothing.
async function showAllMedia(page: Page, thorough = false): Promise<void> {
  if (await clickProjectNav(page, "All media").catch(() => false)) return;
  const filter = page.getByRole("button", { name: "Filtering and sorting options" });
  if (!thorough || !(await filter.isVisible().catch(() => false))) return;
  await filter.click({ timeout: 5000 }).catch(() => {});
  await pause(page, 600);
  const menu = page.locator(".cdk-overlay-container");
  if (await menu.locator("input[type=checkbox]:checked").count().catch(() => 0)) {
    await page.getByRole("button", { name: "Clear all filters" }).click({ timeout: 4000 }).catch(() => {});
    await pause(page, 600);
  }
  // New tiles must come first: everything that finds a fresh result looks at the top of the grid.
  const newest = menu.locator("label", { hasText: /^\s*Newest\s*$/ }).locator("input[type=radio]");
  if ((await newest.count().catch(() => 0)) && !(await newest.first().isChecked().catch(() => true))) {
    await newest.first().click({ force: true, timeout: 4000 }).catch(() => {});
    await pause(page, 600);
  }
  await page.keyboard.press("Escape");
  await clearBackdrops(page);
}

async function ensureProjectGrid(page: Page): Promise<void> {
  await dismissOverlays(page);
  const root = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  // Compared by path: an address ending in ?hl=en is already the grid.
  if (root && new URL(page.url()).pathname !== new URL(root).pathname) {
    await page.goto(inEnglish(root), { waitUntil: "domcontentloaded" });
    await pause(page, 2500);
  }
  await showAllMedia(page, true);
  await pause(page, 800);
  await scrollToTop(page);
}

// Drives one generation in the Flow tab and returns the downloaded file paths.
export async function runGeneration(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;

  await ensureProjectGrid(page);
  // Flow can be sitting on its agent session panel - left by an agent batch, or by the user's own agent session, and
  // it survives a reload. That panel replaces the composer, so the Agent chip is not on the page at all, and reading
  // aria-pressed on it used to sit out Playwright's 30 s default and fail the job before anything was even quoted
  // (seen live on Linux, 2026-11-04, on a free still). Close it first, then ask the chip with a short timeout:
  // "no chip" means "not in agent mode", which is exactly what this job wants.
  await closeAgentSession(page);
  await closeAgentSidePanel(page);
  // Issue #43: some Flow UI variants omit the Agent toggle completely while keeping "Settings trigger" visible.
  // When agentIsOn() is null and Settings trigger is showing, treat the composer as already in direct mode.
  const agentState = await agentIsOn(page);
  if (agentState === true) await setAgentMode(page, false);
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();

  job.credits = await applySettings(page, job);
  if (job.credits > s.max_credits) {
    throw new Error(
      `Flow quotes ${job.credits} credits for this scene, above max_credits=${s.max_credits}. Nothing was generated. Raise max_credits or pick a cheaper model/duration/variants.`,
    );
  }

  if (s.first_frame) {
    await attachAsset(page, page.getByRole("button", { name: "Start", exact: true }), await uploadAsset(page, job, s.first_frame, "start"));
  }
  if (s.last_frame) {
    await attachAsset(page, page.getByRole("button", { name: "End", exact: true }), await uploadAsset(page, job, s.last_frame, "end"));
  }
  // Flow's composer offers Frames OR Ingredients, never both: a clip with first/last frames cannot also carry
  // reference images. The frames already pin the look, so the references are dropped and the job says so.
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  if (framesMode && s.reference_images?.length) {
    job.note = [job.note, `first/last frames were set, so ${s.reference_images.length} reference image(s) were skipped — Flow allows one or the other.`]
      .filter(Boolean)
      .join(" · ");
    s.reference_images = [];
  }
  for (const [i, ref] of (s.reference_images ?? []).entries()) {
    const name = await uploadAsset(page, job, ref, `ref${i + 1}`);
    await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
  }
  const wanted = (s.reference_images ?? []).length;
  if (wanted) {
    const attached = await page.getByRole("button", { name: "Ingredient" }).count();
    if (attached < wanted) throw new Error(`Only ${attached} of ${wanted} reference image(s) attached in Flow; nothing was generated.`);
  }

  await typePrompt(page, s.prompt);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt or inputs were not accepted.");
  await scrollToTop(page);
  const before = await mediaIds(page);
  await start.click();

  const variants = s.variants ?? 1;
  const fresh = await waitForNewMedia(page, before, variants, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, job, s.type === "image" ? "image" : "video");
  job.progress = undefined;

  mkdirSync(s.output_dir, { recursive: true });
  const files: string[] = [];
  const failed: string[] = [];
  let firstError: unknown;
  for (const [i, id] of fresh.entries()) {
    const label = fresh.length > 1 ? `${s.file_stem}-v${i + 1}` : s.file_stem;
    // Flow names clips itself and reuses those names, so two takes of one scene come back identically titled and
    // neither can be found by name afterwards. Renaming each finished tile to the scene's own file stem makes every
    // later lookup - download, continue, assemble - unambiguous. A rename that merely fails returns false and the
    // clip is still downloaded; the one thing that is NOT survivable is renaming a tile that is not ours, so that
    // check throws and takes the whole job down with it rather than quietly destroying another asset's name.
    const newTitle = `${basename(s.output_dir)}-${label}`;
    const renamed = await renameTile(page, mediaTile(page, id), newTitle);
    if (renamed) job.note = [job.note, `renamed in Flow to ${newTitle}`].filter(Boolean).join(" · ");
    await pause(page, 800);
    const stem = join(s.output_dir, label);
    // A video at rest has no media id, so it is tracked by its title - which the rename just changed. Looking for the
    // old title failed every such download after 30 s ("locator.waitFor: Timeout 30000ms exceeded ... aria-label=
    // <the prompt>", reported by a user, 2026-10-15) while the clip sat finished and renamed in Flow.
    const handle = renamed && id.startsWith("title:") ? `title:${newTitle}` : id;
    // Each variant is downloaded on its own: one that fails must not stop the others (2026-10-21, an x2 image batch
    // kept only its first take). The failed ones stay in Flow under their new titles for flow_download.
    try {
      files.push(...(await downloadMedia(page, handle, stem, s.download_quality)));
    } catch (err) {
      firstError ??= err;
      failed.push(`${renamed ? newTitle : label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await pause(page, 1500);
  }
  if (failed.length) {
    if (!files.length) throw firstError;
    job.note = [job.note, `not downloaded (still in Flow, fetch with flow_download): ${failed.join(" | ")}`].filter(Boolean).join(" · ");
  }
  return files;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene" | "character" | "collection";
  id?: string;
  // The Library collection the item sits in ("Places/Place B"); absent for the project's own All media grid.
  path?: string;
}

// The grid scan lists Library collections and characters as well as media. flow_trash and flow_rename act on one
// image, video or scene: a collection is a whole folder of work, and before the scan listed them neither tool could
// reach one, so they are refused here rather than quietly becoming things those tools can move or rename.
function refuseNonMedia(asset: FlowAsset, what: string): void {
  if (asset.kind === "collection" || asset.kind === "character") {
    throw new Error(`"${asset.name}" is a ${asset.kind === "collection" ? "Library collection" : "character"}, and only images, videos and scenes can be ${what} from here. Do it in the Flow window.`);
  }
}

// Walks the virtualised grid from the top and collects every tile it passes. Recycled tiles sometimes have no
// media id yet, so entries are keyed by title and the id is filled in from whichever pass saw it.
// `allMedia: false` scans whatever grid is on screen (a Library collection's page) instead of switching to All media.
async function scanGrid(page: Page, stopAt?: (assets: FlowAsset[]) => boolean, { allMedia = true } = {}): Promise<FlowAsset[]> {
  await dismissOverlays(page);
  if (allMedia) await showAllMedia(page);
  await pause(page, 600);
  await scrollToTop(page);
  const seen = new Map<string, FlowAsset>();
  for (let step = 0; step < 200; step++) {
    const batch = await page.evaluate(
      (js) =>
        [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
          name: t.getAttribute("aria-label") ?? "",
          // A scene (several clips on one timeline) is its own tile type; lumping it in with images made it look
          // like a still in the Library and download as a ZIP of loose clips. Library collections and the characters
          // filed in them have their own tile types too (mapped 2026-11-04); both used to be reported as images.
          kind: t.querySelector("flow-collection-tile")
            ? ("collection" as const)
            : t.querySelector("flow-character-tile")
              ? ("character" as const)
              : t.querySelector("flow-scene-tile")
                ? ("scene" as const)
                : t.querySelector("flow-video-tile")
                  ? ("video" as const)
                  : ("image" as const),
          id: (eval(js) as (t: Element) => string | undefined)(t),
        })),
      TILE_ID_JS,
    );
    for (const a of batch) {
      if (!a.name) continue;
      const known = seen.get(a.name);
      if (!known) seen.set(a.name, a);
      else if (!known.id && a.id) known.id = a.id;
    }
    if (stopAt?.([...seen.values()])) break;
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 700);
  }
  return [...seen.values()];
}

// Characters live in their own left-nav section. With none yet, Flow shows a template chooser instead, so only
// entries that actually carry a character thumbnail count.
export async function listCharacters(): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await dismissOverlays(page);
  await openProjectNav(page, "Characters");
  await pause(page, 2500);
  const names = await page.evaluate(() =>
    [...document.querySelectorAll("flow-character-tile")].map((t) => (t as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean),
  );
  await ensureProjectGrid(page).catch(() => {});
  // Strip Material icon ligatures Flow renders as text ("accessibility_new", "person") and its own avatar.
  return [...new Set(names.map((n) => n.replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "").replace(/\s+/g, " ").trim()))].filter(
    (n) => n && n !== "Me",
  );
}

// A run that stopped half-way leaves Flow inside a character's editor, where the project navigation is gone. Done keeps
// whatever is on screen - leaving any other way could drop a finished edit - and then the grid is put back.
async function leaveCharacterEditor(page: Page): Promise<void> {
  if (/\/character(\/|$)/.test(new URL(page.url()).pathname)) {
    await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 10_000 }).catch(() => {});
  }
  await ensureProjectGrid(page).catch(() => {});
}

// The portrait's own toolbar (Download image, Delete image) sits invisible with pointer events off until a real pointer
// moves over the picture - the same rule as grid tiles - so a plain click lands on the image and times out. That, plus
// Playwright's download event, is why an edit that worked never reached disk (2026-10-02). Point at the picture, then
// download through the same watched folders as every other file.
function savePortrait(page: Page, name: string): Promise<string> {
  return oneDownloadAtATime(() => savePortraitNow(page, name));
}

async function savePortraitNow(page: Page, name: string): Promise<string> {
  await useOwnDownloadDir(page);
  const dir = join(OUTPUT_ROOT, "_cast");
  mkdirSync(dir, { recursive: true });
  const picture = page.getByRole("img", { name: "Generated character image" }).first();
  const button = page.getByRole("button", { name: "Download image", exact: true });
  const before = downloadsNow();
  let pressed = false;
  for (let attempt = 0; attempt < 3 && !pressed; attempt++) {
    await hoverTile(page, picture);
    pressed = await button.click({ timeout: 4000 }).then(
      () => true,
      () => false,
    );
  }
  if (!pressed) throw new Error("Flow never showed the portrait's Download image button");
  const file = await waitForDownloadedFile(page, before, 90_000);
  const portrait = join(dir, `${name.replace(/[^\w.-]+/g, "_")}${extensionOf(file)}`);
  moveFile(file, portrait);
  return portrait;
}

// Opens an existing character and restyles its portrait in place (Nano Banana, free) instead of making a new one.
// Without a change it only saves the character's current portrait: for a look changed by hand in Flow, or an edit whose
// portrait never reached disk.
export async function editCharacter(name: string, change?: string, job?: Job): Promise<{ name: string; portrait?: string; note?: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await openCharacter(page, name);

  if (change) {
    const portraitImg = page.getByRole("img", { name: "Generated character image" }).first();
    const before = await portraitImg.getAttribute("src").catch(() => null);

    const box = page.locator(".ProseMirror").last();
    await box.click();
    await page.keyboard.press("ControlOrMeta+a");
    // Delete leaves a full selection standing in this editor; Backspace clears it (mapped 2026-10-02).
    await page.keyboard.press("Backspace");
    // The character editor always draws a wide 16:9 picture (1376x768), whatever shape the portrait was. Told only "make
    // his coat red", it filled the frame with three Pips side by side (2026-10-02), so every edit pins a single figure.
    const told = `${change.replace(/\s*\n+\s*/g, " ").trim().replace(/[.\s]*$/, ".")} Exactly one ${name} in the picture: never add copies of ${name} or extra poses side by side.`;
    await page.keyboard.type(told, { delay: 8 });
    await pause(page, 600);
    const start = page.getByRole("button", { name: "Start generation" });
    if (!(await start.isEnabled())) throw new Error("Flow did not accept the change (Start generation stayed disabled).");
    await start.click();

    const deadline = Date.now() + 4 * 60_000;
    for (;;) {
      await pause(page, 3000);
      const now = await portraitImg.getAttribute("src").catch(() => null);
      const pct = (await page.locator("main").first().innerText()).match(/\d+%/)?.[0];
      if (job) job.progress = pct;
      if (now && now !== before && !pct) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to redraw the character.");
    }
    if (job) job.progress = undefined;
  }

  // From here on the edit is done in Flow. A failed download must never throw that away, so it becomes a note instead.
  let portrait: string | undefined;
  let note: string | undefined;
  try {
    portrait = await savePortrait(page, name);
  } catch (err) {
    note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${err instanceof Error ? err.message : String(err)}). Call flow_character_edit with just the name to save it.`;
  }

  await leaveCharacterEditor(page);
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  return { name, portrait, note };
}

// ---- Library (nested collections) ----
// Mapped live 2026-11-04. The side nav's Library is a tree, `ul[aria-label="Collections"]` > li > `div.nested-list-row`,
// with data-item-id (the collection id; the collection opens at /project/<id>/collection/<item id>), data-depth (0 at
// the top), and on a row with children `.expandable` plus `button.expand-toggle-button[aria-expanded]` ("Expand
// <name>"). Children only exist in the DOM once their parent is expanded, and the whole tree only while the Library
// section is open (its header button is "Toggle library"). A collection's page is the same virtualised grid as All
// media, with `flow-collection-tile` tiles for sub-collections and `flow-character-tile` for characters filed there.
const LIBRARY_TREE = 'ul[aria-label="Collections"]';

function projectRoot(page: Page): string {
  const root = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  if (!root) throw new Error("No Flow project is open.");
  return root;
}

// Opens the Library section and every collapsed branch, reads the whole tree, then folds the menu back the way the
// user had it: branches in reverse order (children before their parents), then the Library section itself.
async function readLibraryTree(page: Page): Promise<FlowCollection[]> {
  const tree = page.locator(LIBRARY_TREE);
  const toggle = page.getByRole("button", { name: "Toggle library", exact: true });
  let openedLibrary = false;
  if (!(await tree.count().catch(() => 0))) {
    // No Library section (a project without collections) or the menu is hidden: nothing to walk.
    if (!(await toggle.isVisible().catch(() => false))) return [];
    await toggle.click({ timeout: 5000 });
    await leaveSideMenu(page);
    openedLibrary = true;
    if (!(await tree.waitFor({ state: "attached", timeout: 5000 }).then(() => true, () => false))) {
      await toggle.click({ timeout: 5000 }).catch(() => {});
      await leaveSideMenu(page);
      return [];
    }
  }
  const row = (id: string) => tree.locator(`div.nested-list-row[data-item-id="${cssAttrValue(id)}"] button.expand-toggle-button`);
  const expanded: string[] = [];
  try {
    for (let i = 0; i < 500; i++) {
      const id = await page.evaluate(
        (sel) => document.querySelector(sel)?.closest(".nested-list-row")?.getAttribute("data-item-id") ?? null,
        `${LIBRARY_TREE} button.expand-toggle-button[aria-expanded="false"]`,
      );
      // A branch that did not open on the first click would come back here forever; stop rather than spin.
      if (!id || expanded.includes(id)) break;
      await row(id).click({ timeout: 5000 });
      await leaveSideMenu(page);
      expanded.push(id);
      await pause(page, 450);
    }
    const rows = await page.evaluate(
      (sel) =>
        [...document.querySelectorAll(`${sel} div.nested-list-row`)].map((r) => ({
          id: r.getAttribute("data-item-id") ?? "",
          depth: Number(r.getAttribute("data-depth") ?? 0),
          name: (r.querySelector(".item-label")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        })),
      LIBRARY_TREE,
    );
    return buildCollectionTree(rows);
  } finally {
    for (const id of [...expanded].reverse()) {
      await row(id).click({ timeout: 3000 }).catch(() => {});
      await pause(page, 200);
    }
    // One click on the toggle right after the last collapse was sometimes swallowed while the tree re-rendered, and the
    // Library stayed open (2026-11-04). Check that it really closed, and click again if not.
    for (let i = 0; openedLibrary && i < 3 && (await tree.count().catch(() => 0)); i++) {
      await pause(page, 400);
      await toggle.click({ timeout: 3000 }).catch(() => {});
      await pause(page, 600);
    }
    await leaveSideMenu(page);
  }
}

// Opens one collection's own page and scans its grid. Items carry the collection's path.
async function scanCollection(page: Page, root: string, collection: FlowCollection, stopAt?: (assets: FlowAsset[]) => boolean): Promise<FlowAsset[]> {
  await page.goto(inEnglish(`${root}/collection/${encodeURIComponent(collection.id)}`), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-container", { timeout: 20_000 }).catch(() => {
    throw new Error(`The Library collection "${collection.path}" did not load (${page.url()}). Try again.`);
  });
  await pause(page, 2500);
  return (await scanGrid(page, stopAt, { allMedia: false })).map((a) => ({ ...a, path: collection.path }));
}

// Every Library collection of the open project, top to bottom.
export async function listCollections(): Promise<FlowCollection[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  return readLibraryTree(page);
}

// `recursive` walks All media and then every Library collection; `collection` lists just one collection (by path, or
// by name when that is unique). Without either, the project's All media grid only - the behaviour before collections.
export async function listAssets({ recursive = false, collection }: { recursive?: boolean; collection?: string } = {}): Promise<FlowAsset[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  // From a scene, clip or character view the grid is not on screen, and the scan found nothing at all (2026-10-12:
  // a scene open in Flow listed as "no scenes"). Go back to the project's All media first.
  await ensureProjectGrid(page);
  if (!recursive && !collection) {
    const assets = await scanGrid(page);
    await scrollToTop(page);
    return assets;
  }
  const root = projectRoot(page);
  const tree = await readLibraryTree(page);
  try {
    if (collection) {
      const target = findCollection(tree, collection);
      const items = await scanCollection(page, root, target);
      // Sub-collection tiles carry no id of their own; take it from the tree, as a recursive walk does.
      return items.map((a) => {
        if (a.kind !== "collection") return a;
        const sub = tree.find((c) => c.name === a.name && parentPath(c.path) === target.path);
        return { name: a.name, kind: "collection" as const, id: sub?.id, path: target.path };
      });
    }
    // Collections are listed from the tree (which has their ids and full paths), not from their tiles.
    const out: FlowAsset[] = (await scanGrid(page)).filter((a) => a.kind !== "collection");
    for (const c of tree) {
      out.push({ name: c.name, kind: "collection", id: c.id, ...(c.depth ? { path: parentPath(c.path) } : {}) });
      out.push(...(await scanCollection(page, root, c)).filter((a) => a.kind !== "collection"));
    }
    return out;
  } finally {
    await ensureProjectGrid(page).catch(() => {});
  }
}

// A character tile's menu has no Download (Add to prompt, Favorite, Copy, Rename, Move out of collection, Move to
// trash - mapped 2026-11-04), so its portrait comes from the character's own editor, the way flow_character_edit saves it.
async function downloadCharacterTile(page: Page, asset: FlowAsset, targetStem: string): Promise<string[]> {
  const card = tileOf(page, asset);
  await card.scrollIntoViewIfNeeded();
  await card.locator("flow-character-tile").first().click({ timeout: 10_000 });
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await pause(page, 2000);
  try {
    const portrait = await savePortrait(page, asset.name);
    const target = `${targetStem}${extname(portrait)}`;
    // Copy, not rename: the portrait stays in the _cast cache for later use.
    copyFileSync(portrait, target);
    return [target];
  } finally {
    await leaveCharacterEditor(page);
  }
}

// Downloads media that already exists in the project, matched by (the start of) its title. A name of the form
// "<collection path>/<title>" is looked up inside that Library collection instead.
export async function downloadAsset(name: string, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  if (name.includes("/")) {
    const root = projectRoot(page);
    const ref = splitLibraryRef(await readLibraryTree(page), name);
    if (ref) {
      if (!ref.title) throw new Error(`"${ref.collection.path}" is a collection. Name an item in it, such as "${ref.collection.path}/<title>", or list it with flow_assets.`);
      try {
        const want = ref.title.toLowerCase();
        const hit = (a: FlowAsset) => a.name.toLowerCase().startsWith(want);
        const found = (await scanCollection(page, root, ref.collection, (assets) => assets.some(hit))).find(hit);
        if (!found) throw new Error(`No item whose title starts with "${ref.title}" in the Library collection "${ref.collection.path}". Use flow_assets with collection: "${ref.collection.path}" to list it.`);
        if (found.kind === "collection") throw new Error(`"${refOf(found)}" is a collection. Download the items in it by their own paths.`);
        if (found.kind === "character") return await downloadCharacterTile(page, found, targetStem);
        if (found.kind === "scene") return await downloadScene(page, found, targetStem);
        return await downloadTile(page, tileOf(page, found), targetStem, quality);
      } finally {
        await ensureProjectGrid(page).catch(() => {});
      }
    }
    // No collection matches the start of the name: it is just a title with a slash in it.
  }
  const matches = (a: FlowAsset) => a.name.toLowerCase().startsWith(name.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No asset whose title starts with "${name}". Use flow_assets to list titles (recursive: true includes the Library).`);
  if (found.kind === "collection")
    throw new Error(`"${found.name}" is a Library collection. Pass collection: "${found.name}" to download it as one ZIP, or list it with flow_assets (collection: "${found.name}") and download individual items as "${found.name}/<title>".`);
  if (found.kind === "character") return downloadCharacterTile(page, found, targetStem);
  if (found.kind === "scene") return downloadScene(page, found, targetStem);
  return downloadTile(page, tileOf(page, found), targetStem, quality);
}

// Moves one item in the open project to Flow's Trash. Flow keeps it there with Restore and Delete permanently, so this
// is recoverable - and it never deletes permanently. Flow asks NO confirmation (mapped 2026-10-01: the tile menu's
// "Move to trash" removes the tile at once), so whoever calls this must confirm with the user first. Matching is by
// EXACT title, and an ambiguous title is refused: Flow reuses titles, and trashing the wrong one is the worst outcome.
// How many tiles carry this exact title. scanGrid keeps one entry per title (the virtual grid shows the same tile again
// as it scrolls), so it can never see two items with the same name: trashAsset's "two share it" guard never fired,
// and Flow's agent reuses titles freely (three "Red fox sitting in snow" in one test, 2026-10-18). Images are told apart
// by their media ids; id-less videos only when two of them are on screen together.
async function countTitled(page: Page, name: string): Promise<number> {
  await scrollToTop(page);
  const ids = new Set<string>();
  let together = 0;
  for (let step = 0; step < 200; step++) {
    const found = await page.evaluate(
      ([js, title]) => {
        const idOf = eval(js) as (t: Element) => string | undefined;
        return [...document.querySelectorAll("flow-grid-tile-container")].filter((t) => t.getAttribute("aria-label") === title).map((t) => idOf(t) ?? "");
      },
      [TILE_ID_JS, name] as const,
    );
    together = Math.max(together, found.length);
    for (const id of found) if (id && !id.startsWith("title:")) ids.add(id);
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 500);
  }
  await scrollToTop(page);
  return Math.max(ids.size, together);
}

export async function trashAsset(name: string): Promise<{ trashed: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const same = (await scanGrid(page)).filter((a) => a.name === name);
  if (!same.length) throw new Error(`Nothing in the open project is called "${name}".`);
  refuseNonMedia(same[0], "moved to Flow's Trash");
  const copies = await countTitled(page, name);
  if (copies > 1) throw new Error(`${copies} items are called "${name}", so it isn't clear which one to trash. Rename one in Flow first.`);
  // Scan again, stopping on the tile so it stays mounted in the virtual grid (no scrollToTop before acting on it).
  await scanGrid(page, (seen) => seen.some((a) => a.name === name));
  const tile = tileOf(page, same[0]);
  await hoverTile(page, tile);
  await tile.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await pause(page, 2000);
  if (await tile.count()) throw new Error(`"${name}" is still in the project - Flow did not move it to Trash.`);
  await scrollToTop(page);
  return { trashed: name };
}

// Renames one item in the open project through the tile menu's `Rename`. runGeneration already does this for every
// clip it makes; this is the same thing on demand, for putting a name back when something went wrong - on
// 2026-10-21 two frames of clip 3 ended up wearing the portraits' names and there was no way to undo it from here.
// Matching is by EXACT title and an ambiguous one is refused, as in trashAsset: Flow reuses titles, and renaming the
// wrong item is how the damage happened in the first place. The target name is refused if it is already taken, so a
// rename can never create that ambiguity either.
export async function renameAsset(name: string, newName: string): Promise<{ renamed: string; to: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  if (name === newName) throw new Error(`"${name}" is already called that.`);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const assets = await scanGrid(page);
  const same = assets.filter((a) => a.name === name);
  if (!same.length) throw new Error(`Nothing in the open project is called "${name}". Use flow_assets to list titles.`);
  refuseNonMedia(same[0], "renamed");
  const copies = await countTitled(page, name);
  if (copies > 1) throw new Error(`${copies} items are called "${name}", so it isn't clear which one to rename. Rename one by hand in Flow first.`);
  if (assets.some((a) => a.name === newName)) throw new Error(`Something in the project is already called "${newName}". Pick a title that is free.`);
  // Scan again, stopping on the tile so it stays mounted in the virtual grid (no scrollToTop before acting on it).
  await scanGrid(page, (seen) => seen.some((a) => a.name === name));
  if (!(await renameTile(page, tileOf(page, same[0]), newName, false))) {
    throw new Error(`Flow's tile menu did not offer Rename for "${name}", so nothing was changed.`);
  }
  await scrollToTop(page);
  // Flow writes the new title into the tile optimistically and reconciles with its server afterwards, so right after
  // a rename the grid can show the new title, fall back to the old one, and only settle a minute later (watched that
  // happen on 2026-10-21 while putting two portraits' names back). A single scan is therefore no proof either way:
  // this waits for a scan that has the new title and no longer has the old one.
  for (let attempt = 0; attempt < 5; attempt++) {
    await pause(page, 4000);
    const now = await scanGrid(page);
    if (now.some((a) => a.name === newName) && !now.some((a) => a.name === name)) return { renamed: name, to: newName };
  }
  throw new Error(
    `Flow has not settled on "${newName}" for "${name}". Look at the project in Flow before renaming anything again - the rename may still land on its own.`,
  );
}

// A scene's tile menu downloads a ZIP of its loose clips, which is not what anyone wants. The whole scene comes out as
// ONE stitched file from inside the scene view: open the scene, press "Download scene", and Flow shows "Exporting your
// scene..." before the file arrives (a 29 s scene took a few seconds). The user showed this route; verified 2026-10-01.
// Nothing may be pressed while it exports - an Escape here cancelled an earlier attempt.
function downloadScene(page: Page, scene: FlowAsset, targetStem: string): Promise<string[]> {
  return oneDownloadAtATime(() => downloadSceneNow(page, scene, targetStem));
}

async function downloadSceneNow(page: Page, scene: FlowAsset, targetStem: string): Promise<string[]> {
  await useOwnDownloadDir(page);
  const tile = tileOf(page, scene);
  await hoverTile(page, tile);
  const box = await tile.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.click();
  await page.waitForURL(/\/scene\//, { timeout: 30_000 });
  await pause(page, 3000);
  const before = downloadsNow();
  await page.getByRole("button", { name: "Download scene", exact: true }).click();
  const file = await waitForDownloadedFile(page, before, 600_000);
  const target = `${targetStem}${extensionOf(file)}`;
  moveFile(file, target);
  await page.getByRole("button", { name: "Back button to go to previous page" }).click().catch(() => {});
  await pause(page, 2000);
  await ensureProjectGrid(page).catch(() => {});
  return [target];
}

export interface CharacterParams {
  name: string;
  image?: string;
  describe?: string;
  aspect_ratio?: string;
  personality?: string;
  voice?: string;
}

// Creates a reusable Flow character from an image (local file, or "asset:<title>" already in the project).
// Afterwards it can be attached to any scene as reference "asset:<character name>".
// What each character looks like, so scenes can hold Flow to the same design instead of letting it redraw.
// Kept on disk so a restarted server still knows the cast.
const loadLooks = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(looksFile(currentAccount()), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
};
export const characterLook = (name: string): string | undefined => loadLooks()[name.toLowerCase()];
export function forgetCharacter(name: string): void {
  const all = loadLooks();
  if (!(name.toLowerCase() in all)) return;
  delete all[name.toLowerCase()];
  writeFileSync(looksFile(currentAccount()), JSON.stringify(all, null, 2));
}
export function rememberCharacter(name: string, look: string): void {
  const a = currentAccount();
  const all = { ...loadLooks(), [name.toLowerCase()]: look.trim() };
  mkdirSync(accountDir(a), { recursive: true });
  writeFileSync(looksFile(a), JSON.stringify(all, null, 2));
}

// Which voice each character has. Flow shows it in the character editor and nowhere else, and a copy of a character (a new
// outfit) has to get the SAME voice as the original, so the choice is kept on disk too, keyed by name.
const loadVoices = (): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(voicesFile(currentAccount()), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
};
export const characterVoice = (name: string): string | undefined => loadVoices()[name.toLowerCase()];
export function rememberVoice(name: string, voice: string | undefined): void {
  const a = currentAccount();
  const all = loadVoices();
  if (voice) all[name.toLowerCase()] = voice;
  else delete all[name.toLowerCase()];
  mkdirSync(accountDir(a), { recursive: true });
  writeFileSync(voicesFile(a), JSON.stringify(all, null, 2));
}

// A tile's textContent is "<name>accessibility_newfavoritemore_vert" (icon ligatures glued on, no space; innerText has a
// newline), so "Ollie" must not match "Ollie_Village": the name has to be followed by the icon text or the end. The old
// plain hasText search opened the wrong character for any name that starts another (2026-10-19: "Ollie" opened
// "Ollie_Village").
const characterTile = (page: Page, name: string) =>
  page.locator("flow-character-tile").filter({ hasText: characterTilePattern(name) }).first();

// Opens a character's editor page from the Characters section.
async function openCharacter(page: Page, name: string): Promise<void> {
  await leaveCharacterEditor(page);
  await dismissOverlays(page);
  await openProjectNav(page, "Characters");
  await pause(page, 2500);
  const card = characterTile(page, name);
  if (!(await card.isVisible().catch(() => false))) throw new Error(`No character called "${name}". Use flow_characters to list them.`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await pause(page, 2000);
}

// The editor shows the voice as a button NAMED after it ("orus"), right before "Play preview" and "Remove". A character
// without one shows "Select a voice" instead (mapped live 2026-10-19).
async function readVoice(page: Page): Promise<string | undefined> {
  // Short timeout: this also runs after every character is made, and a page without a <main> would otherwise sit
  // out Playwright's 30 s default before the caller's catch saw it.
  return parseVoiceFromSnapshot(await page.locator("main").first().ariaSnapshot({ timeout: 5000 }));
}

// Narrows the voice list with the dialog's search box when it has one. Best effort and quick: fill() waits 30 s for a
// box that is not there, and the voices shown first are still pickable without it.
async function searchVoices(dialog: Locator, voice: string): Promise<void> {
  const box = dialog.getByRole("textbox", { name: "Search assets" }).or(dialog.getByPlaceholder("Search assets")).first();
  await box.fill(voice, { timeout: 2000 }).catch(() => {});
}

// Chooses a stock voice in the open character editor. Both the "Select a voice" button and the current voice's button
// open the same dialog. The list shows only the first voices, so the search box reaches the rest. "Customize performance"
// would generate a NEW voice, so it is left alone.
async function pickVoice(page: Page, voice: string): Promise<void> {
  const current = await readVoice(page);
  const opener = current ? page.getByRole("button", { name: current, exact: true }) : page.getByRole("button", { name: "Select a voice" });
  await opener.first().click();
  const dialog = page.getByRole("dialog").first();
  const list = dialog.getByRole("listbox", { name: "Asset list" });
  await list.waitFor({ state: "visible", timeout: 10_000 });
  await searchVoices(dialog, voice);
  await pause(page, 900);
  const option = optionByName(list, voice);
  if (!(await option.isVisible().catch(() => false))) {
    const available = (await list.getByRole("option").allInnerTexts()).map((t) => t.split("\n").filter((l) => l && l !== "voice_selection").join(" - "));
    await dialog.getByRole("button", { name: "Close" }).click().catch(() => {});
    throw new Error(`Voice "${voice}" not found. Available: ${available.join("; ")}`);
  }
  await option.click();
  await dialog.getByRole("button", { name: "Add to character", exact: true }).click();
  await pause(page, 1200);
  const now = await readVoice(page);
  if (now?.toLowerCase() !== voice.toLowerCase()) throw new Error(`Flow did not take the voice: ${now ? `"${now}"` : "no voice"} instead of "${voice}".`);
}

// Gives an existing character a stock voice. Returns the old one too.
export async function setCharacterVoice(name: string, voice: string): Promise<{ name: string; voice: string; previous?: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await openCharacter(page, name);
  const previous = await readVoice(page);
  try {
    if (previous?.toLowerCase() !== voice.toLowerCase()) await pickVoice(page, voice);
  } finally {
    await leaveCharacterEditor(page);
  }
  rememberVoice(name, voice.toLowerCase());
  return { name, voice: voice.toLowerCase(), previous };
}

// Reads what voice each named character has, straight from Flow (about 8 s each), and remembers it.
export async function characterVoices(names: string[]): Promise<Record<string, string | null>> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const out: Record<string, string | null> = {};
  try {
    for (const name of names) {
      await openCharacter(page, name);
      const voice = await readVoice(page);
      rememberVoice(name, voice);
      out[name] = voice ?? null;
    }
  } finally {
    await leaveCharacterEditor(page);
  }
  return out;
}

export async function createCharacter(c: CharacterParams, job?: Job): Promise<{ name: string; url: string; portrait?: string; voice?: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  // A description generates the portrait first (free image), then the character is built from that picture.
  let portrait: string | undefined;
  if (!c.image) {
    if (!c.describe) throw new Error("Pass either an image or a description for the character.");
    if (job) job.progress = "drawing the character";
    const dir = join(OUTPUT_ROOT, "_cast");
    const made = await runGeneration({
      ...(job ?? ({ id: "char", status: "running", files: [], attempts: 1, createdAt: "" } as unknown as Job)),
      files: [],
      params: {
        prompt: c.describe,
        type: "image",
        max_credits: 0,
        aspect_ratio: (c.aspect_ratio as "3:4") ?? "3:4",
        output_dir: dir,
        file_stem: c.name.replace(/[^\w.-]+/g, "_"),
      },
    } as Job);
    portrait = made[0];
    c = { ...c, image: portrait };
  }
  const image = c.image!;
  const projectUrl = page.url();
  await dismissOverlays(page);
  await scrollToTop(page);

  await openProjectNav(page, "Characters");
  await pause(page, 1500);
  // With no characters yet Flow jumps straight to the creation page.
  const create = page.getByRole("button", { name: "New character" });
  if (await create.isVisible().catch(() => false)) await create.click();
  await page.waitForURL(/\/character$/, { timeout: 15_000 });

  if (image.startsWith(ASSET_PREFIX)) {
    const title = image.slice(ASSET_PREFIX.length).trim();
    await page.getByRole("button", { name: "Add from project", exact: true }).click();
    const list = page.getByRole("listbox", { name: "Asset list" });
    await list.waitFor({ state: "visible", timeout: 10_000 });
    let option = optionByName(list, title);
    if (!(await option.isVisible().catch(() => false))) {
      await page.getByRole("tab", { name: "Uploads" }).click();
      await pause(page, 1000);
      option = optionByName(list, title);
    }
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape");
      throw new Error(`No image titled "${title}" in the Flow project. Use flow_assets to list titles.`);
    }
    await option.click();
    await page.getByRole("button", { name: "Add media", exact: true }).click();
  } else {
    if (!existsSync(image)) throw new Error(`File not found: ${image}`);
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await (await chooser).setFiles(image);
  }
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const url = page.url();

  const name = page.getByRole("textbox", { name: "Character name" });
  await name.waitFor({ state: "visible", timeout: 15_000 });
  await name.fill(c.name);
  await name.press("Enter");
  if (c.personality) await page.getByRole("textbox", { name: "Character personality" }).fill(c.personality);

  if (c.voice) {
    await page.getByRole("button", { name: "Select a voice" }).click();
    const dialog = page.getByRole("dialog").first();
    const voices = dialog.getByRole("listbox", { name: "Asset list" });
    await voices.waitFor({ state: "visible", timeout: 10_000 });
    await searchVoices(dialog, c.voice);
    await pause(page, 900);
    const option = optionByName(voices, c.voice);
    if (!(await option.isVisible().catch(() => false))) {
      const available = (await voices.getByRole("option").allInnerTexts()).map((t) => t.split("\n").filter((l) => l && l !== "voice_selection").join(" - "));
      await dialog.getByRole("button", { name: "Close" }).click().catch(() => {});
      throw new Error(`Voice "${c.voice}" not found. Character was created without a voice. Available: ${available.join("; ")}`);
    }
    await option.click();
    // "Customize performance" would turn this into generating a new voice (preview + save); stock voices only.
    await dialog.getByRole("button", { name: "Add to character", exact: true }).click();
    await pause(page, 1000);
  }
  // Whatever voice the character ended up with (Flow may give one on its own) is kept for later copies.
  const voice = await readVoice(page).catch(() => undefined);
  rememberVoice(c.name, voice);

  // Flow labels this "Done editing" or just "Done" depending on the panel state.
  await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click();
  await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 15_000 }).catch(() => page.goto(inEnglish(projectUrl)));
  await pause(page, 1000);
  // Flow drops the new character into the composer; leave the composer empty for the next job.
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  await showAllMedia(page);
  if (c.describe) rememberCharacter(c.name, c.describe);
  return { name: c.name, url, portrait, voice };
}

const EDIT_TIMEOUT_MS = 10 * 60_000;

// Video-to-video edit in Flow's edit view ("make it sunset", "remove the cup"). Flow shows no quote here, so the
// cost is measured from the balance instead (a 4 s Omni clip cost 20 credits). The result is a new tile.
export async function runEdit(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const title = s.edit_asset!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);
  // New tiles always appear at the top, so the "before" snapshot is taken there, ahead of the search: scrolling
  // back to the top after the scan would unmount the tile we are about to click (the grid is virtualised).
  const before = await mediaIds(page);
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(title.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No video whose title starts with "${title}". Use flow_assets to list titles.`);

  const tile = tileOf(page, found);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForURL(/\/edit\//, { timeout: 20_000 });
  await pause(page, 2500);

  const box = page.locator(".ProseMirror").last();
  await box.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  const prompt = s.prompt.replace(/\s*\n+\s*/g, " ").trim();
  await page.keyboard.type(prompt, { delay: 8 });
  await pause(page, 600);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow did not accept the edit prompt (Start generation stayed disabled).");
  await start.click();

  // Progress shows as "NN% <prompt>" inside the edit view and disappears when the edit is ready.
  const deadline = Date.now() + EDIT_TIMEOUT_MS;
  let seenProgress = false;
  for (;;) {
    await pause(page, 3000);
    const text = await page.locator("main").first().innerText();
    const pct = text.match(/(\d+)%/)?.[0];
    job.progress = pct;
    if (pct) seenProgress = true;
    else if (seenProgress) break;
    const failure = text.split("\n").find((l) => FAILURE_TEXT.test(l) && !l.includes(prompt));
    if (!pct && failure && Date.now() > deadline - EDIT_TIMEOUT_MS + 15_000) throw new Error(`Flow reported a failed edit: ${failure.slice(0, 300)}`);
    if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to finish the edit.");
  }
  job.progress = undefined;

  await page.getByRole("button", { name: "Back button to go to previous page" }).click();
  await pause(page, 2500);
  await ensureProjectGrid(page);
  const fresh = await waitForNewMedia(page, before, 1, 90_000, undefined, "video");
  mkdirSync(s.output_dir, { recursive: true });
  const saved = await downloadMedia(page, fresh[0], join(s.output_dir, s.file_stem), s.download_quality);
  const after = await readCredits(page).catch(() => undefined);
  if (balance !== undefined && after !== undefined) job.credits = balance - after;
  return saved;
}

// The agent session panel hides the composer, so a toggle attempted underneath it does nothing at all. Leaving agent
// mode on then breaks the NEXT job, which expects the plain composer - a free character build failed that way. So this
// confirms the toggle actually landed rather than assuming the click worked.
async function setAgentMode(page: Page, on: boolean): Promise<void> {
  const agent = agentToggle(page);
  // Playwright says why a click did not land ("<div ...> intercepts pointer events", "element is not visible"); keep
  // that, so a failure names what was in the way instead of guessing.
  let why = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await clearBackdrops(page);
    await closeAgentSettings(page);
    await closeAgentSidePanel(page);
    const current = await agentIsOn(page);
    if (current === on) return;
    if (current === null) {
      const toggleVisible = await agent.isVisible().catch(() => false);
      // Issue #43: no toggle in the DOM while Settings trigger is visible means the composer is already in direct mode.
      if (!toggleVisible && !on && (await settingsTrigger(page).isVisible().catch(() => false))) return;
      if (!toggleVisible && on) {
        throw new Error(
          "Could not switch Agent mode on: Flow's composer has no Agent toggle (Agent / Flow Agent / Turn on Flow Agent) on this page.",
        );
      }
    }
    await agent.click({ timeout: 8000 }).catch((err: Error) => {
      const lines = err.message.split("\n").map((l) => l.trim());
      why = (lines.find((l) => /intercepts pointer events|not visible|not enabled|detached|not stable/.test(l)) ?? lines[0]).slice(0, 200);
    });
    await pause(page, 1500);
  }
  const finalState = await agentIsOn(page);
  if (finalState !== on) {
    if (!on && finalState === null && (await settingsTrigger(page).isVisible().catch(() => false))) return;
    throw new Error(`Could not switch Agent mode ${on ? "on" : "off"}${why ? ` (${why})` : "; the click landed but the toggle did not change"}.`);
  }
}

// "Never" lets the agent generate without asking; it is switched back to "Always" as soon as the batch ends.
async function setAgentSettings(page: Page, confirm: "Always" | "Never", imageAspect?: string, imageModel?: string): Promise<void> {
  // Scoped to the prompt box: Flow added a second "Settings" button to the top bar ("View settings", seen 2026-10-13),
  // and an unscoped lookup matched both and failed every agent batch.
  // Renamed "Settings" -> "Agent settings" on 2026-11-21; either name works.
  await clearBackdrops(page);
  await page.locator("flow-base-prompt-box").getByRole("button", { name: /^(Agent s|S)ettings$/ }).click();
  try {
    const panel = page.locator("flow-agent-panel");
    await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "visible", timeout: 8000 });
    await panel.getByRole("radio", { name: new RegExp(`^${confirm}`) }).click();
    if (imageAspect) {
      // Aspect, outputs and model now live in the "Image defaults" sub-panel, and every change saves by itself.
      const defaults = panel.getByRole("button", { name: /^Image defaults/ });
      if (await defaults.isVisible().catch(() => false)) {
        await defaults.click();
        await page.getByRole("heading", { name: "Image defaults" }).waitFor({ state: "visible", timeout: 8000 });
      }
      await panel.getByRole("radio", { name: imageAspect, exact: true }).first().click();
      await panel.getByRole("radio", { name: "x1", exact: true }).first().click();
      await pickAgentImageModel(page, imageModel);
    }
    await pause(page, 300);
    // The old panel had a Save button; the new one saves as you go.
    const save = page.getByRole("button", { name: "Save", exact: true });
    if (await save.isVisible().catch(() => false)) await save.click();
    await pause(page, 1200);
  } finally {
    // Saved or not, never leave the panel covering the composer: the next step needs the Agent button.
    await closeAgentSettings(page);
  }
}

// "Reuse prompt" on an agent-made tile opens the agent's session panel, which hides the normal composer.
async function closeAgentSession(page: Page): Promise<void> {
  // The panel is `flow-agent-panel`, the same element the agent SETTINGS panel uses; the session one is the variant
  // with "Start new session" and "Close". Either way it sits where the composer goes and takes the Agent chip and
  // "Settings trigger" off the page with it, so both are closed here. Check visibility rather than count() so a
  // hidden DOM shell never triggers an 8 s wait or clicks an unrelated Close button on the page.
  const panel = page.locator("flow-agent-panel").first();
  const panelVisible = await panel.isVisible().catch(() => false);
  const sessionVisible = await page.getByRole("button", { name: "Start new session" }).isVisible().catch(() => false);
  if (panelVisible || sessionVisible) {
    const panelClose = panel.getByRole("button", { name: "Close", exact: true }).first();
    if (await panelClose.isVisible().catch(() => false)) {
      await panelClose.click({ timeout: 8000 }).catch(() => {});
    } else if (sessionVisible) {
      await page.getByRole("button", { name: "Close", exact: true }).first().click({ timeout: 8000 }).catch(() => {});
    }
    await pause(page, 1000);
    await closeAgentSettings(page);
  }
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click().catch(() => {});
  else {
    // No composer to clear is not a failure here: the caller checks for what it needs next and says so properly.
    await page.locator(".ProseMirror").first().click({ timeout: 5000 }).then(
      async () => {
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.press("Delete");
      },
      () => {},
    );
  }
  await pause(page, 400);
}

const STOP_WORDS = new Set("the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "));
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

// Returns, per scene, the indexes of the tiles that belong to it (best match first). A tile counts when at least
// half of the scene's meaningful words appear in the prompt Flow stored for that tile.
export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  // Words that most scenes share (a long common style paragraph) say nothing about WHICH scene a picture is, and they
  // drowned the distinctive ones: 8 scenes sharing one style text matched 1 of 7 pictures (2026-11-07). Match on what
  // is particular to each scene.
  const all = scenes.map(words);
  const count = new Map<string, number>();
  for (const ws of all) for (const w of ws) count.set(w, (count.get(w) ?? 0) + 1);
  const common = (w: string) => scenes.length > 2 && (count.get(w) ?? 0) >= Math.max(2, Math.ceil(scenes.length * 0.6));
  const sceneWords = all.map((ws) => {
    const own = new Set([...ws].filter((w) => !common(w)));
    return own.size >= 3 ? own : ws;
  });
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter((w) => have.has(w)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  // First give every scene its single best tile, then hand leftover tiles to their best scene as extra takes.
  for (const firstPass of [true, false]) {
    for (const { scene, tile, score } of pairs) {
      // a third of a scene's own words is plenty once the shared boilerplate is gone (the agent paraphrases)
      if (score < 0.3 || usedTiles.has(tile) || (firstPass && out[scene].length)) continue;
      out[scene].push(tile);
      usedTiles.add(tile);
    }
  }
  return out;
}

interface RoundOutcome {
  produced: number;
  timedOut: boolean;
  failedTiles: number;
  // What the agent wrote back, when it drew nothing (it answers in text instead of generating).
  reply?: string;
}

// Scenes per request to Flow's agent. 17 and 20 worked; 30 and 39 came back with nothing drawn (2026-11-07).
const AGENT_CHUNK = 20;

// One pass through Flow's agent for the given scene numbers: ask, wait, match the new tiles back to those scenes
// and download them. Returns how many scenes it actually delivered.
// Bulk downloads go at an even, human pace: as quick as the steps allow (about 2.5 s), then held to a random 4-4.4 s each
// (the user's call, 2026-10-19), in the spirit of the random pauses between generations. Before, each took ~5.6 s.
const downloadPace = () => 4000 + Math.random() * 400;

// Progress the panel and flow_wait show; with FLOW_MCP_DEBUG set, also a timed line on stderr to find slow steps.
const t0s = new WeakMap<Job, number>();
function step(job: Job, text: string | undefined): void {
  job.progress = text;
  if (!process.env.FLOW_MCP_DEBUG || !text) return;
  if (!t0s.has(job)) t0s.set(job, Date.now());
  console.error(`[flow-mcp ${job.id}] ${((Date.now() - t0s.get(job)!) / 1000).toFixed(1)}s ${text}`);
}

// One collection per batch, named after its folder and job, so a rerun never mixes with an older set.
const collectionFor = (job: Job) => `${basename(job.params.output_dir)}-${job.id}`;

async function agentRound(
  page: Page,
  job: Job,
  scenes: string[],
  indexes: number[],
  retry: boolean,
  files: string[],
  done: Set<number>,
): Promise<RoundOutcome> {
  const s = job.params;
  const aspect = s.aspect_ratio ?? "16:9";
  const base = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  const numberOf = (i: number) => s.agent_numbers?.[i] ?? base + i;
  await ensureProjectGrid(page);
  const seenBefore = await scanGrid(page);
  // Ids are unique per generation; titles are not (the agent reuses wording), so only id-less tiles fall back to a name.
  const before = new Set<string>(seenBefore.map((a) => a.id).filter((v): v is string => Boolean(v)));
  const beforeNames = new Set<string>(seenBefore.filter((a) => !a.id).map((a) => a.name));
  await scrollToTop(page);

  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  // Reference images ride along as ingredient chips, attached the way the + button does, once per round (the composer
  // is cleared between rounds). The script then names them, and each scene says which ones it uses.
  const refs = s.agent_refs ?? [];
  const assets = s.agent_ref_assets ?? [];
  if (refs.length) {
    for (const [k, name] of assets.entries()) {
      step(job, `attaching reference ${k + 1} of ${assets.length}`);
      await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
      await pause(page, 700);
    }
    const attached = await page.getByRole("button", { name: "Ingredient" }).count();
    if (attached < assets.length) throw new Error(`Only ${attached} of ${assets.length} reference image(s) attached in the agent composer.`);
  }
  const usesOf = (i: number) => s.agent_scene_refs?.[i];
  const script = indexes
    .map((i) => {
      const uses = usesOf(i);
      const tag = !refs.length || !uses ? "" : uses.length ? ` (use references: ${uses.join(", ")})` : " (no reference)";
      return `Scene ${numberOf(i)}${tag}: ${scenes[i].replace(/\s*\n+\s*/g, " ").trim()}`;
    })
    .join(" ");
  const legend = refs.length
    ? ` The ${refs.length} attached image(s) are references: ${refs.map((r, k) => `${assets[k] ?? `image ${k + 1}`} is ${r.name}`).join("; ")}. ` +
      `Whenever a scene shows one of them, keep it exactly as it looks in its reference (face, hair, clothing, shape, colours), ` +
      `but stage each scene as its own description says; the references are for likeness only, never copy their pose or background.`
    : "";
  const lead = retry
    ? `${indexes.length} image(s) from the last batch failed to generate. Generate them again now, one image per scene`
    : `Generate exactly ${indexes.length} separate images, one image per scene, in scene order`;
  const ask = `${lead}. Images only, never video. ${aspect} aspect ratio. Do not ask questions, generate them now.${legend} ${script}`;
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.insertText(ask);
  await pause(page, 800);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's agent did not accept the script (Start generation stayed disabled).");
  const textBefore = new Set((await page.locator("body").innerText().catch(() => "")).split("\n").map((l) => l.trim()));
  await start.click();

  // The agent shows a Stop button while it works and "NN%" on every tile it is rendering.
  const deadline = Date.now() + (3 * 60_000 + indexes.length * 30_000);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  let idleSince = 0;
  let timedOut = false;
  for (;;) {
    await pause(page, 3000);
    const main = await page.locator("main").first().innerText();
    const pending = main.match(/\d+%/g) ?? [];
    const working = pending.length > 0 || (await stop.isVisible().catch(() => false));
    step(job, working ? (pending.length ? `${pending.length} rendering` : "the agent is working") : "the agent has finished");
    if (working) idleSince = 0;
    else if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > 8000) break;
    if (Date.now() > deadline) {
      // A tile that hangs must not sink the batch: stop the agent and keep whatever finished.
      timedOut = true;
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
      await pause(page, 2000);
      break;
    }
  }

  step(job, "checking for failed tiles");
  const failedTiles = await retryNewErrorTiles(page, before, true)
    .then((r) => r.errors)
    .catch(() => 0);
  // New tiles always appear at the TOP, so only tiles above the first one already known count. A scan of a big project
  // can miss a tile far down ("Hmida", 181st of 189, 2026-10-24); the next scan then found it, called it new, and its
  // missing Reuse prompt sank an agent round that had in fact delivered every image.
  const after = await scanGrid(page);
  const firstKnown = after.findIndex((t) => (t.id && before.has(t.id)) || (!t.id && beforeNames.has(t.name)));
  const fresh = (firstKnown < 0 ? after : after.slice(0, firstKnown)).filter((t) => t.id && !before.has(t.id) && !beforeNames.has(t.name) && t.kind === "image");
  if (!fresh.length) {
    // Nothing drawn: keep what the agent wrote instead, so the reason reaches the user rather than a silent retry.
    const reply = (await page.locator("body").innerText().catch(() => ""))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 25 && !textBefore.has(l) && !/^\d+%/.test(l) && !l.startsWith("Generate exactly") && !l.includes("Scene 1"))
      .join(" ")
      .slice(0, 600);
    await closeAgentSession(page);
    return { produced: 0, timedOut, failedTiles, reply: reply || undefined };
  }

  // Tiles finish in any order and the agent rewords prompts, so each image is matched back to its scene by the
  // prompt Flow stored for it ("Reuse prompt" puts that text in the composer).
  const prompts: string[] = [];
  for (const [k, tile] of fresh.entries()) {
    step(job, `matching image ${k + 1} of ${fresh.length} to its scene`);
    await scanGrid(page, (seen) => seen.some((x) => x.id === tile.id));
    const el = mediaTile(page, tile.id!);
    await hoverTile(page, el, 250);
    // A tile without Reuse prompt (an upload, a character picture) matches no scene; it must not end the round.
    const reused = await el
      .getByRole("button", { name: "Reuse prompt" })
      .click({ timeout: 6000 })
      .then(() => true, () => false);
    if (reused) await pause(page, 900);
    prompts.push(reused ? await page.locator(".ProseMirror").first().innerText({ timeout: 5000 }).catch(() => "") : "");
  }
  await closeAgentSession(page);

  const assigned = matchScenes(
    indexes.map((i) => scenes[i]),
    prompts,
  );
  const drop = Number(process.env.FLOW_MCP_SIMULATE_MISSING ?? 0); // test hook: pretend this scene number failed
  mkdirSync(s.output_dir, { recursive: true });
  const wanted: { scene: number; id: string; stem: string }[] = [];
  for (const [n, tileIndexes] of assigned.entries()) {
    const sceneIndex = indexes[n];
    if (!tileIndexes.length || (numberOf(sceneIndex) === drop && !s.agent_numbers)) continue;
    for (const [v, tileIndex] of tileIndexes.entries())
      wanted.push({ scene: sceneIndex, id: fresh[tileIndex].id!, stem: join(s.output_dir, `scene-${String(numberOf(sceneIndex)).padStart(2, "0")}${v ? `-v${v + 1}` : ""}`) });
  }
  let produced = 0;
  if ((s.download_quality ?? "original") === "original" && wanted.length) {
    // The user's way (2026-11-07): gather the whole batch into one collection and fetch it as ONE ZIP, instead of a
    // tile menu per image (4.2 s each). Originals only; an upscaled batch still goes tile by tile.
    const saved = await collectAndDownload(page, job, collectionFor(job), wanted);
    files.push(...saved.values());
  } else {
    for (const w of wanted) {
      const started = Date.now();
      // New tiles sit at the top of the grid, so a scan is only needed when this one has scrolled out of the page.
      if (!(await mediaTile(page, w.id).count())) await scanGrid(page, (seen) => seen.some((x) => x.id === w.id));
      step(job, `downloading scene ${numberOf(w.scene)}`);
      files.push(...(await downloadTile(page, mediaTile(page, w.id), w.stem, s.download_quality ?? "original")));
      await pause(page, Math.max(0, downloadPace() - (Date.now() - started)));
    }
  }
  for (const scene of new Set(wanted.map((w) => w.scene))) {
    done.add(scene);
    produced++;
  }
  return { produced, timedOut, failedTiles };
}

// Hands a whole multi-scene script to Flow's own agent, which generates every image in parallel (seconds instead
// of one paced job per scene). Scenes the agent drops are asked for again, then re-run one by one as a last resort.
// Continues a clip from its own last frame WITH characters still attached - the combination the composer refuses.
// Flow's composer offers Frames OR Ingredients, never both, but agent mode does both, and this is the route the user
// demonstrated: save the clip's last frame, Animate that image (which switches Flow into agent mode by itself), then
// add the avatar or character as a second chip. Verified step by step against the live UI on 2026-09-20.
export async function runContinue(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const balance = await readCredits(page).catch(() => undefined);

  await ensureProjectGrid(page);
  const wanted = s.continue_from!.toLowerCase();
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(wanted);
  const source = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!source) throw new Error(`No video whose title starts with "${s.continue_from}". Use flow_assets to list titles.`);

  try {
    // 1. Open the clip and park the playhead on its final frame, then let Flow save that frame as an image.
    job.progress = "saving the last frame";
    const tile = tileOf(page, source);
    await hoverTile(page, tile);
    await tile.click();
    await page.waitForURL(/\/edit\//, { timeout: 30_000 });
    await pause(page, 4000);
    await page.getByRole("button", { name: "Skip to next clip" }).click();
    await pause(page, 2500);
    await page.getByRole("button", { name: "Save frame" }).click();
    await pause(page, 4500);
    await page.getByRole("button", { name: "Back button to go to previous page" }).click();
    await pause(page, 3500);
    await ensureProjectGrid(page);
    await scrollToTop(page);

    // 2. Animate the frame we just saved. Flow names it after the source and puts the newest copy at the top, and
    //    the click also flips Agent on, which is what lets a character ride along.
    job.progress = "loading the frame into the composer";
    const frame = page.locator(`flow-grid-tile-container[aria-label="${cssAttrValue(`Saved frame from ${source.name}`)}"]`).first();
    await frame.waitFor({ state: "visible", timeout: 30_000 });
    await hoverTile(page, frame);
    await frame.getByRole("button", { name: "More options" }).click();
    await pause(page, 1500);
    await page.getByRole("menuitem", { name: "Animate", exact: true }).click();
    await pause(page, 3500);
    await setAgentMode(page, true);

    // 3. The second chip: an avatar ("Me") or any character. Only useful in likeness mode - Flow's first-frame tool
    //    (I2V) ignores extra references, and attaching one just makes the agent stop and ask which we meant.
    for (const name of s.continue_mode === "likeness" ? (s.attach ?? []) : []) {
      await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
      await pause(page, 1200);
    }

    // 4. Agent mode asks for confirmation unless told not to, which would stall an unattended run.
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9", s.model);
    // Agent mode treats both chips as ingredients and decides what to do with them. Attaching the saved frame is not
    // enough - without being told, the agent reads it as a style reference and stages a fresh shot. It has to be told
    // in words that the frame IS the opening frame. (Cost 15 credits to learn on 2026-09-20.)
    const cast = (s.attach ?? []).join(" and ");
    const exact = s.continue_mode !== "likeness";
    // Naming the tool settles it in one go. Flow offers first-frame animation (I2V), which continues an image exactly
    // but ignores other references, or reference-to-video (R2V), which honours a character but only approximates the
    // frame. Left unsaid, the agent stops mid-run and asks - which stalls an unattended job.
    await typePrompt(
      page,
      (exact
        ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly ` +
          `on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an ` +
          `unbroken continuation of the shot it came from. Do not use any other reference.`
        : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, ` +
          `so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`) +
        ` ${s.prompt}`,
    );
    const before = await mediaIds(page);
    job.progress = "generating";
    await page.getByRole("button", { name: "Start generation" }).click();

    // The agent sometimes still stops to ask which tool to use. Nobody is watching an unattended run, so answer it.
    for (let i = 0; i < 12; i++) {
      await pause(page, 5000);
      const asking = await page.evaluate(() => /Would you like to|which you prefer|I2V|R2V/i.test(document.body.innerText));
      const working = await page.evaluate(() => /\d{1,3}%/.test(document.body.innerText));
      if (working) break;
      if (!asking) continue;
      job.progress = "answering the agent's question";
      await typePrompt(
        page,
        exact
          ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
          : "Use R2V, reference-to-video, using both attached references so the person stays consistent.",
      );
      await page.keyboard.press("Enter");
      await pause(page, 6000);
      break;
    }

    const fresh = await waitForNewMedia(page, before, 1, VIDEO_TIMEOUT_MS, job, "video");
    job.progress = undefined;
    mkdirSync(s.output_dir, { recursive: true });
    const saved = await downloadMedia(page, fresh[0], join(s.output_dir, s.file_stem), s.download_quality);
    const after = await readCredits(page).catch(() => undefined);
    if (balance !== undefined && after !== undefined) job.credits = balance - after;
    return saved;
  } finally {
    // Leave the composer the way the rest of the driver expects to find it. Order matters: the session panel has to go
    // first and the grid has to be back, otherwise the toggles below are clicking at something that is not there.
    await closeAgentSession(page).catch(() => {});
    await pause(page, 1500);
    await ensureProjectGrid(page).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
    const clear = page.getByRole("button", { name: "Clear prompt" });
    if (await clear.isVisible().catch(() => false)) await clear.click().catch(() => {});
  }
}

export async function runAgentBatch(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const scenes = s.agent_scenes!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);

  const files: string[] = [];
  const done = new Set<number>();
  const firstNumber = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  const numberOf = (i: number) => s.agent_numbers?.[i] ?? firstNumber + i;
  let agentTimedOut = false;
  let failedTiles = 0;
  let agentRetries = 0;
  let agentProblem = "";
  let collectionProblem = "";
  try {
    // References are uploaded once with readable names (the agent sees them), before Agent mode hides the upload menu.
    // Uploads live in one account's project: a retry that lands on another account uploads them there again.
    if (s.agent_refs?.length && (!s.agent_ref_assets?.length || s.agent_ref_account !== currentAccount().name)) {
      await setAgentMode(page, false);
      const assets: string[] = [];
      for (const [k, r] of s.agent_refs.entries()) {
        step(job, `uploading reference ${k + 1} of ${s.agent_refs.length} (${r.name})`);
        const label = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `ref${k + 1}`;
        assets.push(await uploadAsset(page, job, r.image, label));
      }
      s.agent_ref_assets = assets;
      s.agent_ref_account = currentAccount().name;
    }
    step(job, "switching Agent mode on");
    await setAgentMode(page, true);
    step(job, "setting the agent to generate without asking");
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9", s.model);
    rounds: for (let round = 0; round < 3; round++) {
      const todo = scenes.map((_, i) => i).filter((i) => !done.has(i));
      if (!todo.length) break;
      if (round) {
        agentRetries += todo.length;
        job.progress = `asking the agent again for ${todo.length} scene(s)`;
      }
      for (let c = 0; c < todo.length; c += AGENT_CHUNK) {
        const chunk = todo.slice(c, c + AGENT_CHUNK);
        if (todo.length > AGENT_CHUNK) step(job, `asking the agent for scenes ${numberOf(chunk[0])}-${numberOf(chunk[chunk.length - 1])}`);
        const out = await agentRound(page, job, scenes, chunk, round > 0, files, done);
        agentTimedOut ||= out.timedOut;
        failedTiles = out.failedTiles;
        if (!out.produced) {
          // The agent drew nothing for a whole request: stop asking it, and never quietly switch to one by one.
          if (!done.size) agentProblem = `it drew nothing${out.reply ? `; it said: "${out.reply}"` : ""}.`;
          break rounds;
        }
      }
    }
  } catch (err) {
    // A download that stopped is NOT a reason to make the images again or to fetch them another way: they exist in
    // Flow. Stop, and say where they are.
    if (err instanceof CollectionError) collectionProblem = err.message;
    // Agent mode could not be used (2026-10-13: "Could not switch Agent mode on" failed a whole 11-image batch with
    // nothing made). Whatever the agent did not deliver is made one by one below instead: slower, but the batch still
    // ends with every image.
    else agentProblem = (err as Error).message;
  } finally {
    step(job, "putting the agent settings back");
    await ensureProjectGrid(page).catch(() => {});
    await closeAgentSession(page).catch(() => {});
    await setAgentMode(page, true).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
  }

  // Agent mode failing outright is NOT a reason to make the whole batch one image at a time (the user, 2026-11-07:
  // "I always see you creating one by one"). Stop and say why; the one-by-one route is only for the few scenes a
  // working agent dropped.
  if (agentProblem && !done.size) {
    throw new Error(`Flow's agent could not run this batch: ${agentProblem} Nothing was made one by one instead.`);
  }
  if (collectionProblem) {
    throw new Error(
      `${collectionProblem} The images are in Flow (collection "${collectionFor(job)}" if they were moved there): ` +
        `flow_download with collection "${collectionFor(job)}" fetches them as one ZIP without generating anything. ` +
        (files.length ? `Saved before it stopped: ${files.length} file(s) in ${s.output_dir}.` : "Nothing was saved yet."),
    );
  }

  // Anything the agent still has not delivered is generated one by one, which is slower but exact.
  const missing = scenes.map((_, i) => i).filter((i) => !done.has(i));
  const failed: number[] = [];
  const stillFails = Number(process.env.FLOW_MCP_SIMULATE_FAILED ?? 0); // test hook: pretend this scene failed for good
  // A scene made one by one keeps its references: the uploaded copies when there are some, else the original files.
  const refsFor = (i: number): string[] | undefined => {
    const refs = s.agent_refs ?? [];
    if (!refs.length) return undefined;
    const uses = s.agent_scene_refs?.[i];
    const picked = refs
      .map((r, k) => ({ r, k }))
      .filter(({ r }) => !uses || uses.some((u) => u.toLowerCase() === r.name.toLowerCase()))
      .slice(0, 3);
    return picked.length ? picked.map(({ r, k }) => (s.agent_ref_assets?.[k] ? `${ASSET_PREFIX}${s.agent_ref_assets[k]}` : r.image)) : undefined;
  };
  // One by one is only for the odd scene a working agent dropped. More than a few go back as "still failed", and
  // Retry asks the agent again for just those, in bulk.
  const MAX_ONE_BY_ONE = 3;
  if (missing.length > MAX_ONE_BY_ONE) {
    failed.push(...missing.map(numberOf));
    missing.length = 0;
  }
  for (const [n, i] of missing.entries()) {
    job.progress = `re-running scene ${numberOf(i)} one by one (${n + 1}/${missing.length})`;
    if (numberOf(i) === stillFails && !job.params.agent_numbers) {
      failed.push(numberOf(i));
      continue;
    }
    const single: Job = {
      ...job,
      files: [],
      params: {
        prompt: scenes[i],
        type: "image",
        model: s.model,
        max_credits: 0,
        reference_images: refsFor(i),
        aspect_ratio: s.aspect_ratio,
        download_quality: s.download_quality,
        output_dir: s.output_dir,
        file_stem: `scene-${String(numberOf(i)).padStart(2, "0")}`,
      },
    };
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      if (attempt || n) await pause(page, 8000);
      try {
        files.push(...(await runGeneration(single)));
        ok = true;
      } catch {
        /* one more attempt, then give up on this scene */
      }
    }
    if (!ok) failed.push(numberOf(i));
  }
  job.failed_scenes = failed.length ? failed : undefined;
  step(job, "reading the credit balance");
  const left = await readCredits(page).catch(() => undefined);
  step(job, undefined);
  files.sort();
  job.note = [
    // What still needs doing first: the panel shows only the start of a long note.
    failed.length ? `still failed: scene ${failed.join(", ")} (use Retry)` : "",
    agentProblem ? `agent mode failed (${agentProblem}), so the images were made one by one` : "",
    agentTimedOut ? "the agent stalled and was stopped" : "",
    `${done.size} of ${scenes.length} scenes came from the agent`,
    s.agent_refs?.length ? `${s.agent_refs.length} reference image(s) attached` : "",
    agentRetries ? `${agentRetries} asked again` : "",
    failedTiles ? `${failedTiles} tile(s) failed in Flow` : "",
    missing.length > failed.length ? `${missing.length - failed.length} re-run one by one` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!files.length) throw new Error("No image could be generated for any scene. Open the Flow tab to see what Flow reported.");

  if (balance !== undefined && left !== undefined) job.credits = balance - left;
  return files;
}

// A fresh Flow project, so a film can start from scratch without anyone clicking. Mapped live (2026-10-30): Flow's home
// page has one button "New project", which opens /project/<uuid>; on the project page the name is a text box whose
// accessible name is "Editable text" (it holds Flow's default name, e.g. "Oct 29 - 22:17").
export async function createProject(title?: string): Promise<{ id: string; url: string; title: string }> {
  const page = await getFlowPage();
  await page.goto(inEnglish("https://flow.google.com/"), { waitUntil: "domcontentloaded" });
  const button = page.getByRole("button", { name: /new project/i }).first();
  await button.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error("Flow's home page shows no \"New project\" button. Check the Flow window is signed in.");
  });
  await button.click();
  await page.waitForURL(/\/project\/[0-9a-f-]{36}/, { timeout: 30_000 }).catch(() => {
    throw new Error("Pressed \"New project\" but Flow did not open a project within 30 s.");
  });
  const id = page.url().match(/\/project\/([0-9a-f-]{36})/)![1];
  const name = page.getByRole("textbox", { name: "Editable text" }).first();
  await name.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (title?.trim()) {
    await name.fill(title.trim()).catch(() => undefined);
    await name.press("Enter").catch(() => undefined);
    await page.waitForTimeout(1200);
  }
  const shown = (await name.inputValue().catch(() => "")) || title || "";
  return { id, url: `https://flow.google.com/project/${id}`, title: shown };
}
