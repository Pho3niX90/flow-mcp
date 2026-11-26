// Pure parsing, validation, and classification helpers for Google Flow Music (https://www.flowmusic.app/).
// Kept free of Playwright so every rule is unit-tested directly without Chrome.

export type MusicFormat = "m4a" | "mp3" | "wav";

export const MUSIC_OBSERVED_PRICE = 5;
export const MUSIC_DEFAULT_MAX_CREDITS = 10;

export const MUSIC_FORMAT_LABEL: Record<MusicFormat, string> = {
  m4a: "M4A",
  mp3: "MP3",
  wav: "WAV",
};

export const MUSIC_FORMAT_EXT: Record<MusicFormat, string> = {
  m4a: ".m4a",
  mp3: ".mp3",
  wav: ".wav",
};

export interface MusicParams {
  sound: string;
  lyrics?: string;
  instrumental?: boolean;
  title?: string;
  length_seconds?: number;
  bpm?: number;
  seed?: string;
  model?: string;
  formats?: MusicFormat[];
}

export interface MusicClip {
  id: string;
  title: string;
  seconds?: number;
  lyrics?: string;
  sound?: string;
  seed?: string;
  created_at?: string;
  audio_url?: string;
  wav_url?: string;
  has_wav: boolean;
}

// Hosts from which Flow Music clip audio files may be fetched directly without going through the browser menu.
export const MUSIC_MEDIA_HOSTS = ["storage.googleapis.com"] as const;

export type MusicDownloadRoute =
  | { route: "direct"; url: string }
  | { route: "convert"; url: string }
  | { route: "menu"; reason: "no_ffmpeg" | "no_url" | "untrusted_url" };

// Allows only plain https: URLs on an allow-listed host (no credentials, no http:, no blob:/data:, no look-alike hosts).
export function isAllowedMusicMediaUrl(rawUrl: string | undefined, allowedHosts: readonly string[] = MUSIC_MEDIA_HOSTS): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return allowedHosts.some((h) => h.toLowerCase() === host);
}

// Decides how to obtain one format of a clip: direct HTTPS fetch (m4a/wav), local FFmpeg conversion from fetched m4a
// (mp3 when ffmpeg is available), or fallback to Flow Music's page menu.
export function chooseMusicDownloadRoute(
  clip: Pick<MusicClip, "audio_url" | "wav_url">,
  format: MusicFormat,
  hasFfmpeg: boolean,
  allowedHosts: readonly string[] = MUSIC_MEDIA_HOSTS,
): MusicDownloadRoute {
  const rawUrl = format === "wav" ? clip.wav_url : clip.audio_url;
  if (!rawUrl || !rawUrl.trim()) return { route: "menu", reason: "no_url" };
  if (!isAllowedMusicMediaUrl(rawUrl, allowedHosts)) return { route: "menu", reason: "untrusted_url" };
  const url = rawUrl.trim();
  if (format === "mp3") {
    return hasFfmpeg ? { route: "convert", url } : { route: "menu", reason: "no_ffmpeg" };
  }
  return { route: "direct", url };
}

export interface MusicCredits {
  credits_remaining?: number;
  tokens_remaining?: number;
}

export type MusicStatusResult =
  | { state: "complete"; clipId?: string }
  | { state: "working"; progress?: number | null }
  | { state: "failed"; reason: string };

// Flow Music's Length field clamps to 1:00..3:00 and only accepts M:SS safely (bare numbers like "90" turn into "3:00").
export function formatMusicLength(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 180) {
    throw new Error(`length_seconds must be a whole number from 60 to 180 (1:00 to 3:00); got ${seconds}.`);
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function validateMusicBpm(bpm: number): string {
  if (!Number.isInteger(bpm) || bpm < 20 || bpm > 400) {
    throw new Error(`bpm must be a whole number from 20 to 400; got ${bpm}.`);
  }
  return String(bpm);
}

export function validateMusicSeed(seed: string | number): string {
  const s = String(seed).trim();
  if (!/^\d+$/.test(s)) throw new Error(`seed must contain digits only; got "${seed}".`);
  return s;
}

export function validateMusicFormats(formats?: MusicFormat[]): MusicFormat[] {
  const list = formats?.length ? formats : (["m4a"] as MusicFormat[]);
  const unique: MusicFormat[] = [];
  for (const f of list) {
    if (f !== "m4a" && f !== "mp3" && f !== "wav") throw new Error(`Unsupported music format "${String(f)}". Use m4a, mp3, or wav.`);
    if (!unique.includes(f)) unique.push(f);
  }
  return unique;
}

// Parses a single clip object from Flow Music's /__api/clips or /__api/clips/auth-user response, tolerant of missing fields.
export function parseMusicClip(raw: unknown): MusicClip | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return null;

  const op = r.operation && typeof r.operation === "object" && !Array.isArray(r.operation) ? (r.operation as Record<string, unknown>) : undefined;
  const rawTitle = typeof r.title === "string" && r.title.trim() ? r.title.trim() : typeof op?.title === "string" && op.title.trim() ? op.title.trim() : "";
  const title = rawTitle || "Untitled";

  let seconds: number | undefined;
  const dur = r.duration && typeof r.duration === "object" && !Array.isArray(r.duration) ? (r.duration as Record<string, unknown>).value : r.duration;
  const durNum = typeof dur === "number" ? dur : typeof dur === "string" && dur.trim() ? Number(dur) : NaN;
  if (Number.isFinite(durNum) && durNum > 0) seconds = Math.round(durNum);

  let lyrics: string | undefined;
  if (typeof r.lyrics === "string") {
    lyrics = r.lyrics;
  } else if (r.lyrics && typeof r.lyrics === "object" && !Array.isArray(r.lyrics)) {
    const val = (r.lyrics as Record<string, unknown>).value;
    if (val && typeof val === "object" && !Array.isArray(val) && typeof (val as Record<string, unknown>).text === "string") {
      lyrics = (val as Record<string, unknown>).text as string;
    } else if (typeof val === "string") {
      lyrics = val;
    }
  }

  const sound = typeof op?.sound_prompt === "string" && op.sound_prompt.trim() ? op.sound_prompt.trim() : undefined;
  const seed = op?.seed !== undefined && op?.seed !== null && String(op.seed).trim() !== "" ? String(op.seed).trim() : undefined;
  const created_at = typeof r.created_at === "string" && r.created_at.trim() ? r.created_at.trim() : undefined;
  const audio_url = typeof r.audio_url === "string" && r.audio_url.trim() ? r.audio_url.trim() : undefined;
  const wav_url = typeof r.wav_url === "string" && r.wav_url.trim() ? r.wav_url.trim() : undefined;
  const has_wav = Boolean(wav_url);

  return {
    id,
    title,
    ...(seconds !== undefined ? { seconds } : {}),
    ...(lyrics !== undefined ? { lyrics } : {}),
    ...(sound !== undefined ? { sound } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(created_at !== undefined ? { created_at } : {}),
    ...(audio_url !== undefined ? { audio_url } : {}),
    ...(wav_url !== undefined ? { wav_url } : {}),
    has_wav,
  };
}

// Parses either `{ clips: [...] }` (library) or `{ clips: { "<id>": {...} } }` (POST /__api/clips).
export function parseMusicClipsResponse(body: unknown): MusicClip[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const clips = (body as Record<string, unknown>).clips;
  const entries = Array.isArray(clips)
    ? clips
    : clips && typeof clips === "object"
      ? Object.values(clips as Record<string, unknown>)
      : [];
  const out: MusicClip[] = [];
  for (const item of entries) {
    const parsed = parseMusicClip(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

// Classifies GET /__api/audio-create-song-status/<uuid> payloads.
export function classifyMusicStatus(body: unknown): MusicStatusResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { state: "working" };
  const r = body as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status.trim().toLowerCase() : "";
  const errorType = typeof r.error_type === "string" ? r.error_type.trim() : "";
  const errorMessage = typeof r.error_message === "string" ? r.error_message.trim() : "";
  if (errorType || errorMessage || /^(failed|error|cancelled|canceled|rejected|blocked)$/.test(status)) {
    const reason = [errorType, errorMessage].filter(Boolean).join(": ") || `Flow Music reported status "${r.status}".`;
    return { state: "failed", reason };
  }
  if (status === "complete" || status === "completed" || status === "succeeded" || status === "done") {
    const clipId = typeof r.clip_id === "string" && r.clip_id.trim() ? r.clip_id.trim() : undefined;
    return { state: "complete", clipId };
  }
  const progress = typeof r.progress === "number" ? r.progress : null;
  return { state: "working", progress };
}

// Matches a Flow Music model option (e.g. "Lyria 3.5 Top performing, flagship model" or "Lyria 3 Pro Legacy model")
// by case-insensitive prefix, accepting shorthand like "3.5" or "3 pro" as well as "lyria 3.5" or "lyria 3 pro".
export function matchesMusicModel(optionText: string, wanted: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const opt = norm(optionText);
  const want = norm(wanted);
  if (!opt || !want) return false;
  const checkPrefix = (prefix: string) => {
    if (!opt.startsWith(prefix)) return false;
    const next = opt[prefix.length];
    return next === undefined || /[\s\-–—(:]/.test(next);
  };
  return checkPrefix(want) || (!want.startsWith("lyria ") && checkPrefix(`lyria ${want}`));
}

// Classifies Flow Music sign-in state from the two visibility probes (signed-out buttons vs signed-in sidebar nav).
// Returns false when Log in / Continue with Google is visible, true when signed-in nav is visible, null if still loading.
export function classifyMusicSignedIn({ logInVisible, signedInNavVisible }: { logInVisible: boolean; signedInNavVisible: boolean }): boolean | null {
  if (logInVisible) return false;
  if (signedInNavVisible) return true;
  return null;
}

// Parses GET /__api/billing/credits -> { data: { tokens_remaining, credits_remaining } }.
export function parseMusicCredits(body: unknown): MusicCredits {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const d = data as Record<string, unknown>;
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  const credits_remaining = num(d.credits_remaining);
  const tokens_remaining = num(d.tokens_remaining);
  return {
    ...(credits_remaining !== undefined ? { credits_remaining } : {}),
    ...(tokens_remaining !== undefined ? { tokens_remaining } : {}),
  };
}

// Parses GET /__api/billing/subscription -> { data: { subscription_tier, subscription_plan } }.
export function parseMusicPlan(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  for (const key of ["subscription_tier", "subscription_plan"] as const) {
    if (typeof d[key] === "string" && d[key].trim()) return d[key].trim();
  }
  return undefined;
}

// Credit guard checks (Flow Music shows no credit quote before generating).
export function checkMusicCreditsBefore(maxCredits: number, balance?: number): void {
  if (maxCredits < MUSIC_OBSERVED_PRICE) {
    throw new Error(
      `max_credits (${maxCredits}) is below Flow Music's observed price of ${MUSIC_OBSERVED_PRICE} credits per song. Nothing was generated. Raise max_credits to at least ${MUSIC_OBSERVED_PRICE}.`,
    );
  }
  if (balance !== undefined && balance < MUSIC_OBSERVED_PRICE) {
    throw new Error(
      `Flow Music account has ${balance} credits left, below the observed price of ${MUSIC_OBSERVED_PRICE} credits per song. Nothing was generated.`,
    );
  }
}

export function measureMusicSpend(before?: number, after?: number): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  const diff = before - after;
  return diff >= 0 ? diff : undefined;
}

// Resolves a song query (either clip id or exact title) against library clips; refuses ambiguous titles with matching ids.
export function resolveMusicSongQuery(clips: readonly MusicClip[], query: string): { ok: true; clip: MusicClip } | { ok: false; error: string } {
  const q = query.trim();
  const byId = clips.find((c) => c.id === q);
  if (byId) return { ok: true, clip: byId };
  const byTitle = clips.filter((c) => c.title === q);
  if (byTitle.length === 1) return { ok: true, clip: byTitle[0] };
  if (byTitle.length > 1) {
    return {
      ok: false,
      error: `${byTitle.length} songs in Flow Music are titled "${q}". Pass the clip id instead: ${byTitle.map((c) => c.id).join(", ")}.`,
    };
  }
  return {
    ok: false,
    error: `No song in Flow Music matches "${q}". Call flow_music_songs to list ids and titles.`,
  };
}
