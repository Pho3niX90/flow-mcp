import { execFile } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { FFMPEG_HINT, ffmpeg } from "./platform.js";

const run = promisify(execFile);

const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// Verifies that an input passed to ffmpeg/ffprobe is an existing regular local file, never a URL or directory.
export function requireLocalFile(file: string, label = "File"): string {
  if (!file || URL_SCHEME_RE.test(file)) {
    throw new Error(`${label} must be a local file on this computer, not a URL: ${file}`);
  }
  const resolved = resolve(file);
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new Error(`${label} not found: ${file}`);
  }
  if (!st.isFile()) {
    throw new Error(`${label} is not a regular file: ${file}`);
  }
  return resolved;
}

function frameOutputPath(src: string, suffix: string, outDir?: string): string {
  const dir = outDir ? resolve(outDir) : dirname(src);
  mkdirSync(dir, { recursive: true });
  const stem = basename(src).replace(/\.\w+$/, "");
  return join(dir, `${stem}${suffix}`);
}

// Saves the final frame of a clip so the next scene can start exactly where this one ended.
export async function extractLastFrame(video: string, outDir?: string): Promise<string> {
  const src = requireLocalFile(video, "Video");
  const out = frameOutputPath(src, "-lastframe.jpg", outDir);
  try {
    await run(ffmpeg(), ["-y", "-sseof", "-0.2", "-i", src, "-update", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`chain_previous needs ffmpeg to grab the previous clip's last frame: ${reason}`);
  }
  return out;
}

// Saves the first frame of a clip, so a new clip can be made to end exactly where that one begins (redoing a middle
// clip with both of its cuts kept invisible).
export async function extractFirstFrame(video: string, outDir?: string): Promise<string> {
  const src = requireLocalFile(video, "Video");
  const out = frameOutputPath(src, "-firstframe.jpg", outDir);
  try {
    await run(ffmpeg(), ["-y", "-i", src, "-frames:v", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`last_frame needs ffmpeg to grab that clip's first frame: ${reason}`);
  }
  return out;
}

// Saves the frame at a chosen second of a clip - where the speech ends, say - so the next clip can start from there
// instead of from dead time at the end. flow_assemble's `trims` then cuts the earlier clip at the same second.
export async function extractFrameAt(video: string, seconds: number, outDir?: string): Promise<string> {
  const src = requireLocalFile(video, "Video");
  const out = frameOutputPath(src, `-frame-${seconds.toFixed(2)}s.jpg`, outDir);
  try {
    await run(ffmpeg(), ["-y", "-ss", seconds.toFixed(3), "-i", src, "-frames:v", "1", "-q:v", "2", out]);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT})` : String(err);
    throw new Error(`first_frame_at needs ffmpeg to grab that frame: ${reason}`);
  }
  return out;
}
