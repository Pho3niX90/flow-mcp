import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Which file is the download Flow just sent. Chrome is told to save into a folder only this tool uses, where every
// new file is ours. When that setting has been reset behind our back the file lands in the user's own Downloads
// folder instead, next to whatever else they are downloading, so a file there is taken only with proof it came from
// Flow. Before this, any file that appeared in ~/Downloads during the wait (up to ten minutes for an upscale) was
// moved into the output folder and renamed as the clip.

// The user's own Downloads folder.
export const SYSTEM_DOWNLOADS = join(homedir(), "Downloads");

// The upscale this tool may pick without asking: 2K for an image, 1080p for a video. Both are free. 4K costs credits on
// plans that offer it, so it is never chosen here; if no free upscale is on offer, the original is taken instead.
export const FREE_UPSCALE = /\b(2K|1080p)\b/i;

export interface DownloadWatch {
  // "<dir>/<name>" of everything in either folder when the watch began.
  seen: Set<string>;
  // When the watch began (ms since the epoch).
  since: number;
}

// Everything already sitting in the given folders, so a new arrival can be told apart from what was there before.
export function snapshotDownloads(dirs: string[], now = Date.now()): DownloadWatch {
  const seen = new Set<string>();
  for (const dir of dirs) if (existsSync(dir)) for (const f of readdirSync(dir)) seen.add(`${dir}/${f}`);
  return { seen, since: now };
}

// What the system recorded about where a downloaded file came from, if anything. On Windows, Chrome writes the page
// and file addresses into the file's "Zone.Identifier" stream. Other systems keep no record this tool reads.
export function downloadOrigin(path: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    return readFileSync(`${path}:Zone.Identifier`, "utf8");
  } catch {
    return undefined;
  }
}

const FLOW_ORIGIN = /^(ReferrerUrl|HostUrl)=https:\/\/(flow\.google\.com|labs\.google)\//im;
export const originIsFlow = (origin: string): boolean => FLOW_ORIGIN.test(origin);

// Whether `file` is what Chrome would call a download it was asked to name `suggested`: that name, or the name with
// " (1)", " (2)"... before the extension when a file of that name was already there.
export function sameDownloadName(file: string, suggested: string): boolean {
  if (!suggested) return false;
  if (file === suggested) return true;
  const dot = suggested.lastIndexOf(".");
  const stem = dot > 0 ? suggested.slice(0, dot) : suggested;
  const ext = dot > 0 ? suggested.slice(dot) : "";
  if (file.length <= suggested.length || !file.startsWith(stem) || !file.endsWith(ext)) return false;
  return /^ \(\d+\)$/.test(file.slice(stem.length, file.length - ext.length));
}

export interface SharedFile {
  name: string;
  // When the file was created (ms since the epoch).
  born: number;
  // downloadOrigin() of the file.
  origin?: string;
}

// Whether a new file in the user's own Downloads folder is the one Flow sent. It has to have been created after the
// watch began, and then either the system says it came from Flow or, where the system keeps no record, Chrome
// announced a download of that name on Flow's page.
export function isFlowDownload(file: SharedFile, watch: DownloadWatch, expectedNames: string[]): boolean {
  // Two seconds of slack: file times are coarser than the clock on some disks.
  if (file.born < watch.since - 2000) return false;
  if (file.origin !== undefined) return originIsFlow(file.origin);
  return expectedNames.some((name) => sameDownloadName(file.name, name));
}

// New arrivals that are ours to take: anything new in our own folder, and only proven Flow downloads in the shared one.
export function newDownloads(watch: DownloadWatch, ownDir: string, sharedDir: string, expectedNames: string[]): string[] {
  const found: string[] = [];
  for (const dir of [ownDir, sharedDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (watch.seen.has(`${dir}/${f}`) || f.endsWith(".crdownload") || f.startsWith(".")) continue;
      const path = join(dir, f);
      if (dir !== ownDir) {
        let born: number;
        try {
          const st = statSync(path);
          if (!st.isFile()) continue;
          born = st.birthtimeMs || st.mtimeMs;
        } catch {
          continue; // gone again between the listing and the look
        }
        if (!isFlowDownload({ name: f, born, origin: downloadOrigin(path) }, watch, expectedNames)) continue;
      }
      found.push(path);
    }
  }
  return found;
}

// Tells when a file has finished arriving: its size held still, above zero, from one look to the next. Each file is
// tracked on its own. The old check remembered a single file, so two arrivals at once kept replacing each other and
// neither ever counted as finished.
export class SettledFiles {
  private sizes = new Map<string, number>();

  // Give it the current candidates and their sizes; it returns the first one whose size has not changed since the
  // last call.
  next(candidates: { path: string; size: number }[]): string | undefined {
    let settled: string | undefined;
    const now = new Map<string, number>();
    for (const { path, size } of candidates) {
      if (settled === undefined && size > 0 && this.sizes.get(path) === size) settled = path;
      now.set(path, size);
    }
    this.sizes = now;
    return settled;
  }
}
