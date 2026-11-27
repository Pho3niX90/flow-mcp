// Pure tile-identity and title-guard helpers shared between Flow grid evaluation and unit tests.

// Media UUID in Flow URLs (e.g. https://flow-content.google/image/<uuid> or .../video/<uuid>).
export const MEDIA_UUID_RE = /[0-9a-f]{8}-[0-9a-f-]{27}/;

// Signed Flow /asb/<token> URLs (stops before any "=s512-rw" or "=mm,22,15" suffix).
export const ASB_TOKEN_RE = /\/asb\/([\w-]{40,})/;

// Extracts a stable tile identity from a media URL: UUID first, then signed /asb/ token.
export function extractMediaIdFromUrl(src: string): string | undefined {
  return src.match(MEDIA_UUID_RE)?.[0] || src.match(ASB_TOKEN_RE)?.[1] || undefined;
}

// Titles this tool gives assets of its own: "<folder>-<file stem>", where the stems are scene-NN / clip-NN /
// edit-NN (with optional -vN variant suffix). A tile already wearing one belongs to an earlier run, never a fresh tile.
export const OUR_TITLE = /-(?:scene|clip|edit)-\d{1,3}(?:-v\d+)?$/i;

// Escapes a value for safe interpolation inside a double-quoted CSS attribute selector (`[attr="..."]`).
export function cssAttrValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\d ")
    .replace(/\n/g, "\\a ")
    .replace(/\f/g, "\\c ")
    .replace(/\0/g, "\\fffd ");
}

// Matches a character tile's exact name (followed by whitespace, end, or Material icon ligatures) so "Ollie" does not match "Ollie_Village".
export function characterTilePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}(?=\\s|$|accessibility_new|person|favorite)`);
}

// Parses the selected voice name from the character editor's ARIA snapshot.
export function parseVoiceFromSnapshot(snap: string): string | undefined {
  if (/button "Select a voice"/.test(snap)) return undefined;
  const lines = snap.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes('button "Play preview"'));
  return at > 0 ? lines[at - 1].match(/button "([^"]+)"/)?.[1] : undefined;
}

// Parses a Flow credit quote like "25 credits" or "1,200 credits". Returns NaN when the text is not a plain count.
export function parseCreditQuote(text: string): number {
  const m = text.match(/^\s*(\d[\d,]*)\s+credits?\s*$/i);
  if (!m) return NaN;
  const digits = m[1].replace(/,/g, "");
  if (!/^\d+$/.test(digits)) return NaN;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : NaN;
}
