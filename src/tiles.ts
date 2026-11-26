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
