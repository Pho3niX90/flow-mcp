import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import type { CDPSession, Page } from "playwright-core";
import { currentAccount, downloadDir } from "./accounts.js";
import { SYSTEM_DOWNLOADS, SettledFiles, kindOfBytes, newDownloads, originsForSite, snapshotDownloads, type DownloadWatch } from "./downloads.js";
import type { Site } from "./sites.js";

export { kindOfBytes };

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

// Each account's Chrome saves into its own folder ("main" keeps <HOME_DIR>/downloads).
const ownDownloads = () => downloadDir(currentAccount());

// Accounts run at the same time, but downloads take turns: a file that slips past the override lands in the shared
// ~/Downloads, and with two accounts downloading at once either watcher could claim the other's file. A download is a
// few seconds, so taking turns costs little.
let downloadTurn: Promise<unknown> = Promise.resolve();
export function oneDownloadAtATime<T>(work: () => Promise<T>): Promise<T> {
  const mine = downloadTurn.then(work, work);
  downloadTurn = mine.catch(() => {});
  return mine;
}

// Download names Chrome announced on a site's page, newest last, kept PER PAGE so two accounts or two site windows
// cannot vouch for each other's files in ~/Downloads (see downloads.ts).
const announcedByPage = new WeakMap<Page, { name: string; at: number }[]>();
const listening = new WeakSet<Page>();
const downloadSessions = new WeakMap<Page, CDPSession>();

export async function applyDownloadDir(cdp: CDPSession, dir: string): Promise<boolean> {
  const behaviour = { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true } as const;
  if (await cdp.send("Browser.setDownloadBehavior", behaviour).then(() => true, () => false)) return true;
  // Chrome 156 refuses the browser-wide call for the default context (upstream issue 22); the older per-page call may
  // still be honoured on the same session, and if not, waitForDownloadedFile watches ~/Downloads with provenance checks.
  return cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }).then(() => true, () => false);
}

// Playwright keeps a download in a per-connection temp file it can delete from under us; pointing Chrome itself at a
// directory we own makes the bytes ours the moment they land.
export async function useOwnDownloadDir(page: Page): Promise<void> {
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
export function downloadsNow(): DownloadWatch {
  return snapshotDownloads([ownDownloads(), SYSTEM_DOWNLOADS]);
}

// Waits for the file the site is sending to finish arriving and returns it. It is looked for in our own download folder
// and, for when the override has been reset behind our back, in Chrome's own: there only a file proven to belong to
// `site` is taken, never something else the user happened to download meanwhile.
export async function waitForDownloadedFile(page: Page, before: DownloadWatch, timeoutMs: number, site: Site = "flow"): Promise<string> {
  const dir = ownDownloads();
  const origins = originsForSite(site);
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
    for (const path of newDownloads(before, dir, SYSTEM_DOWNLOADS, names, origins)) {
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
  if (site === "music") {
    throw new Error(
      "Flow Music started the download but no file arrived in the tool's folder, and nothing new in ~/Downloads came from Flow Music.",
    );
  }
  throw new Error(
    "Flow started the download but no file arrived in the tool's folder, and nothing new in ~/Downloads came from Flow. The media is still in Flow: flow_download fetches it again without spending credits.",
  );
}

// Chrome's "allowAndName" writes each download under a bare id with NO extension, so there is nothing to copy from
// the filename and everything was landing as .mp4 - including stills, which arrived as clip-01.mp4. Read the first
// bytes instead and name the file after what it actually is.
export function extensionOf(file: string): string {
  const head = Buffer.alloc(16);
  const fd = openSync(file, "r");
  let read = 0;
  try {
    read = readSync(fd, head, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  return kindOfBytes(head.subarray(0, read));
}
