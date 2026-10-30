// Flow's UI can spell this model "Omni Flash 1.2" or "Omni 1.2 Flash".
// Keep selection resilient to that order, but never match the retired 1.1.
export const OMNI_FLASH_12 = "Omni Flash 1.2";
export const OMNI_FLASH_12_DURATIONS = Array.from({ length: 13 }, (_, i) => i + 3);

export function isOmniFlash12(name: string): boolean {
  const tokens: string[] = name.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g) ?? [];
  return tokens.includes("omni") && tokens.includes("flash") && tokens.includes("1.2");
}

// Flow renames its models now and then ("Veo 3.1 Lite" became "Veo 3.1 - Lite", 2026-10-30) and prefixes menu items
// with icon ligatures ("volume_up"), so names are compared on letters, digits and dots only.
export const modelKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]/g, "");

export function matchesModelLabel(shown: string, requested: string): boolean {
  if (isOmniFlash12(requested)) return isOmniFlash12(shown);
  const wanted = modelKey(requested);
  return wanted.length > 0 && modelKey(shown).includes(wanted);
}

// Preview only. The classic composer always reads Flow's live credit quote before
// generation; never use this estimate to bypass max_credits.
export function estimateOmniFlash12Credits(duration: number, resolution: "360p" | "720p"): number {
  if (!Number.isInteger(duration) || duration < 3 || duration > 15)
    throw new RangeError("Omni Flash 1.2 supports durations from 3 to 15 seconds");
  const rate = resolution === "360p" ? 1 : 3;
  return rate * Math.min(duration, 10) + 2 * rate * Math.max(0, duration - 10);
}
