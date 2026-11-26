// Pure helpers for Flow's nested Library collections tree and `<collection path>/<title>` refs.
// Refs resolve strictly against the in-memory Flow collection tree and are never treated as filesystem paths.

export interface FlowCollection {
  id: string;
  name: string;
  depth: number;
  // Names from the top of the Library down, joined with "/": "Places/Place B".
  path: string;
}

export const normPath = (path: string): string =>
  path
    .split("/")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .join("/");

export const parentPath = (path: string): string => path.split("/").slice(0, -1).join("/");

export const refOf = (a: { name: string; path?: string }): string => (a.path ? `${a.path}/${a.name}` : a.name);

// Rows come in document order (a parent before its children), so a stack of names indexed by depth gives each path.
export function buildCollectionTree(rows: { id: string; depth: number; name: string }[]): FlowCollection[] {
  const stack: string[] = [];
  const out: FlowCollection[] = [];
  for (const r of rows) {
    if (!r.id || !r.name) continue;
    const depth = Number.isFinite(r.depth) ? Math.max(0, Math.min(Math.floor(r.depth), stack.length)) : 0;
    stack.length = depth;
    stack.push(r.name);
    out.push({ id: r.id, name: r.name, depth, path: stack.join("/") });
  }
  return out;
}

export function findCollection(all: FlowCollection[], path: string): FlowCollection {
  const want = normPath(path);
  const byPath = all.find((c) => normPath(c.path) === want);
  if (byPath) return byPath;
  // A bare name is fine as long as only one collection carries it.
  const byName = all.filter((c) => c.name.toLowerCase() === want);
  if (byName.length === 1) return byName[0];
  const known = all.map((c) => c.path);
  throw new Error(
    byName.length > 1
      ? `Several collections are called "${path}": ${byName.map((c) => c.path).join(", ")}. Pass the full path.`
      : `No Library collection "${path}". ${known.length ? `Collections: ${known.slice(0, 40).join(", ")}${known.length > 40 ? ", ..." : ""}` : "This project's Library is empty."}`,
  );
}

// "Places/Place B/Some title" -> the deepest collection in `tree` the ref starts with, and the title left over.
// Strictly matches collection paths from `tree`; returns undefined if no collection prefix matches (never treats ref as a disk path).
export function splitLibraryRef(tree: FlowCollection[], ref: string): { collection: FlowCollection; title: string } | undefined {
  const parts = ref.replace(/\/+$/, "").split("/");
  // The whole ref may itself be a collection (title ""), so it is tried first.
  for (let i = parts.length; i >= 1; i--) {
    const want = normPath(parts.slice(0, i).join("/"));
    if (!want) continue;
    const collection = tree.find((c) => normPath(c.path) === want);
    if (collection) return { collection, title: parts.slice(i).join("/").trim() };
  }
  return undefined;
}
