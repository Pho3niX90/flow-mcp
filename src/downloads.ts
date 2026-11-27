import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Site } from "./sites.js";

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

export const FLOW_ORIGINS = ["flow.google.com", "labs.google"] as const;
export const MUSIC_ORIGINS = ["flowmusic.app", "www.flowmusic.app"] as const;

export function originsForSite(site: Site): readonly string[] {
  return site === "music" ? MUSIC_ORIGINS : FLOW_ORIGINS;
}

function originPattern(origins: readonly string[]): RegExp {
  const escaped = origins.map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^(ReferrerUrl|HostUrl)=https:\\/\\/(?:${escaped})(?:\\/|[?#]|\\r|$)`, "im");
}

// Whether a Zone.Identifier record proves the file came from one of the given hosts (defaults to Flow's own hosts).
export function originIsFlow(origin: string, origins: readonly string[] = FLOW_ORIGINS): boolean {
  if (!origins.length) return false;
  return originPattern(origins).test(origin);
}

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

// Whether a new file in the user's own Downloads folder is the one the site sent. It has to have been created after
// the watch began. When the system recorded an origin, it must match `origins`, and if Chrome also announced download
// names on that page, the filename must match one of them too. When no origin record exists, the announced name decides.
export function isFlowDownload(
  file: SharedFile,
  watch: DownloadWatch,
  expectedNames: string[],
  origins: readonly string[] = FLOW_ORIGINS,
): boolean {
  // Two seconds of slack: file times are coarser than the clock on some disks.
  if (file.born < watch.since - 2000) return false;
  if (file.origin !== undefined) {
    if (!originIsFlow(file.origin, origins)) return false;
    return expectedNames.length > 0 ? expectedNames.some((name) => sameDownloadName(file.name, name)) : true;
  }
  return expectedNames.some((name) => sameDownloadName(file.name, name));
}

// New arrivals that are ours to take: anything new in our own folder, and only proven site downloads in the shared one.
export function newDownloads(
  watch: DownloadWatch,
  ownDir: string,
  sharedDir: string,
  expectedNames: string[],
  origins: readonly string[] = FLOW_ORIGINS,
): string[] {
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
        if (!isFlowDownload({ name: f, born, origin: downloadOrigin(path) }, watch, expectedNames, origins)) continue;
      }
      found.push(path);
    }
  }
  return found;
}

// Identifies a downloaded file's extension from its leading magic bytes (first 12-16 bytes).
// Chrome's "allowAndName" writes each download under a bare id with NO extension, so naming follows the bytes.
export function kindOfBytes(head: Uint8Array): string {
  const ascii = (start: number, end: number) => Buffer.from(head.subarray(start, end)).toString("latin1");
  // JPEG must be checked before raw MPEG audio sync (JPEG starts FF D8 FF).
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpeg";
  if (head.length >= 4 && head[0] === 0x89 && ascii(1, 4) === "PNG") return ".png";
  if (head.length >= 12 && ascii(0, 4) === "RIFF") {
    const form = ascii(8, 12);
    if (form === "WEBP") return ".webp";
    if (form === "WAVE") return ".wav";
  }
  if (head.length >= 8 && ascii(4, 8) === "ftyp") {
    const brand = head.length >= 12 ? ascii(8, 12) : "";
    if (brand === "M4A " || brand === "M4B ") return ".m4a";
    return ".mp4";
  }
  if (head.length >= 4 && ascii(0, 4) === "GIF8") return ".gif";
  // Flow hands back a ZIP when one tile holds several takes (a generation made at x2-x4): the takes come bundled.
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  if (head.length >= 4 && ascii(0, 4) === "fLaC") return ".flac";
  if (head.length >= 4 && ascii(0, 4) === "OggS") return ".ogg";
  // MP3: either an ID3 tag or an MPEG frame sync (0xFF followed by a byte with the top three bits set).
  if ((head.length >= 3 && ascii(0, 3) === "ID3") || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return ".mp3";
  // Anything else is unknown. Naming it .mp4 (the old fallback) made two ZIPs look like broken videos and broke a cut.
  return ".bin";
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
