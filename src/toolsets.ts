// Progressive tool discovery: groups, summaries, search, mode parsing, and closest-name suggestions.
// Kept pure (no server or I/O) so every piece is tested directly.

export const DISCOVERY_TOOLS = ["flow_tools", "flow_call"] as const;
export type DiscoveryToolName = (typeof DISCOVERY_TOOLS)[number];

export type ToolGroupId =
  | "core"
  | "images"
  | "video"
  | "characters"
  | "projects"
  | "library"
  | "sound"
  | "film"
  | "music";

export interface ToolGroupDef {
  id: ToolGroupId;
  description: string;
  tools: readonly string[];
}

export const TOOL_GROUPS: readonly ToolGroupDef[] = [
  {
    id: "core",
    description: "Status, queue generations, wait/cancel/retry, list/download",
    tools: [
      "flow_status",
      "flow_generate",
      "flow_wait",
      "flow_cancel",
      "flow_retry",
      "flow_assets",
      "flow_download",
    ],
  },
  {
    id: "images",
    description: "Fast agent image batches, transparent PNG cutouts, default model",
    tools: ["flow_agent_images", "flow_cutout", "flow_image_models"],
  },
  {
    id: "video",
    description: "Edit clips, continue from last frame, camera technique presets",
    tools: ["flow_edit", "flow_continue", "flow_techniques"],
  },
  {
    id: "characters",
    description: "Create, list, restyle, or change voices of reusable characters",
    tools: ["flow_character", "flow_character_edit", "flow_characters"],
  },
  {
    id: "projects",
    description: "List, create, open, rename projects; manage parallel accounts",
    tools: [
      "flow_projects",
      "flow_new_project",
      "flow_open_project",
      "flow_rename_project",
      "flow_accounts",
    ],
  },
  {
    id: "library",
    description: "Rename items or move project media to Flow's Trash",
    tools: ["flow_trash", "flow_rename"],
  },
  {
    id: "sound",
    description: "Record free narration, list voices, transcribe audio/video",
    tools: ["flow_narrate", "flow_voices", "flow_transcribe"],
  },
  {
    id: "film",
    description: "Assemble clips into MP4, burn captions, talking presenter",
    tools: ["flow_assemble", "flow_captions", "flow_presenter"],
  },
  {
    id: "music",
    description: "Generate 1-3 min songs in Flow Music, check credits, download",
    tools: [
      "flow_music_status",
      "flow_music",
      "flow_music_songs",
      "flow_music_download",
    ],
  },
];

export const ALL_GROUP_IDS: readonly ToolGroupId[] = TOOL_GROUPS.map((g) => g.id);
export const GROUP_BY_ID: ReadonlyMap<ToolGroupId, ToolGroupDef> = new Map(
  TOOL_GROUPS.map((g) => [g.id, g]),
);

const toolToGroup = new Map<string, ToolGroupId>();
for (const group of TOOL_GROUPS) {
  for (const name of group.tools) {
    if (toolToGroup.has(name)) {
      throw new Error(`Tool "${name}" appears in more than one group (${toolToGroup.get(name)} and ${group.id}).`);
    }
    toolToGroup.set(name, group.id);
  }
}

export const TOOL_TO_GROUP: ReadonlyMap<string, ToolGroupId> = toolToGroup;
export const ALL_GROUPED_TOOLS: readonly string[] = [...toolToGroup.keys()];
export const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set([
  ...GROUP_BY_ID.get("core")!.tools,
  ...DISCOVERY_TOOLS,
]);

export const SERVER_INSTRUCTIONS =
  "flow-mcp drives Google Flow (images, videos, characters) and Google Flow Music (songs) in a local Chrome window, " +
  "plus local FFmpeg, Kokoro, and whisper tools for narration, assembly, and captions. " +
  "By default, only the core tools (status, generate, wait, cancel, retry, assets, download) are listed at first to keep context small. " +
  "Call flow_tools to search or switch on the remaining groups: images, video, characters, projects, library, sound, film, music. " +
  "You can also run any tool by name with flow_call, even if your app does not refresh its tool list.";

export interface ToolMeta {
  name: string;
  group: ToolGroupId;
  title: string;
  description: string;
  params: readonly string[];
}

export interface ParsedToolsMode {
  mode: "progressive" | "all" | "custom";
  enabledGroups: Set<ToolGroupId>;
  unknown: string[];
}

export function parseToolsMode(raw: string | undefined): ParsedToolsMode {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return { mode: "progressive", enabledGroups: new Set<ToolGroupId>(["core"]), unknown: [] };
  }
  const lower = trimmed.toLowerCase();
  if (lower === "progressive") {
    return { mode: "progressive", enabledGroups: new Set<ToolGroupId>(["core"]), unknown: [] };
  }
  if (lower === "all") {
    return { mode: "all", enabledGroups: new Set<ToolGroupId>(ALL_GROUP_IDS), unknown: [] };
  }

  const enabledGroups = new Set<ToolGroupId>(["core"]);
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();
  let sawAll = false;

  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (key === "all") {
      sawAll = true;
      for (const id of ALL_GROUP_IDS) enabledGroups.add(id);
      continue;
    }
    if (GROUP_BY_ID.has(key as ToolGroupId)) {
      enabledGroups.add(key as ToolGroupId);
    } else if (!seenUnknown.has(key)) {
      seenUnknown.add(key);
      unknown.push(token);
    }
  }

  return { mode: sawAll ? "all" : "custom", enabledGroups, unknown };
}

export function assertToolGroupCoverage(registeredToolNames: Iterable<string>): void {
  const discovery = new Set<string>(DISCOVERY_TOOLS);
  const registered = new Set<string>();
  for (const name of registeredToolNames) {
    if (!discovery.has(name)) registered.add(name);
  }

  const ungrouped = [...registered].filter((name) => !TOOL_TO_GROUP.has(name));
  const missing = ALL_GROUPED_TOOLS.filter((name) => !registered.has(name));

  if (ungrouped.length || missing.length) {
    const parts: string[] = [];
    if (ungrouped.length) parts.push(`registered tools missing from TOOL_GROUPS: ${ungrouped.join(", ")}`);
    if (missing.length) parts.push(`TOOL_GROUPS entries not registered: ${missing.join(", ")}`);
    throw new Error(`Tool group coverage mismatch: ${parts.join("; ")}`);
  }
}

// First sentence of a tool description, trimmed cleanly to maxLen characters.
export function summarizeDescription(description: string, maxLen = 120): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (!flat) return "";

  // Find the first sentence terminator (. ! ?) followed by whitespace or end-of-string,
  // skipping common abbreviations like e.g. / i.e.
  let sentence = flat;
  const re = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(flat)) !== null) {
    const end = match.index + 1;
    const before = flat.slice(0, end);
    if (/(?:\b(?:e\.g|i\.e|vs|Mr|Ms|Dr))\.$/i.test(before)) continue;
    sentence = before.trim();
    break;
  }

  if (sentence.length <= maxLen) return sentence;

  // Strip parenthetical asides first so the main clause stays intact when short enough.
  const withoutParens = sentence
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutParens.length <= maxLen) return withoutParens;

  const base = withoutParens.length < sentence.length ? withoutParens : sentence;
  const budget = Math.max(10, maxLen - 3);
  const cut = base.slice(0, budget).replace(/[\s,;:-]+\S*$/, "").replace(/[.,;:-]+$/, "");
  return `${cut || base.slice(0, budget).trimEnd()}...`;
}

export type GroupStatus = "on" | "off" | "partial";

export function groupStatus(groupId: ToolGroupId, enabled: ReadonlySet<string>): { status: GroupStatus; on: number; total: number } {
  const group = GROUP_BY_ID.get(groupId)!;
  let on = 0;
  for (const name of group.tools) {
    if (enabled.has(name)) on++;
  }
  const total = group.tools.length;
  const status: GroupStatus = on === total ? "on" : on === 0 ? "off" : "partial";
  return { status, on, total };
}

// Compact no-argument listing for flow_tools. Keeps the whole overview under 3 KB.
export function formatGroupsOverview(tools: readonly ToolMeta[], enabled: ReadonlySet<string>, summaryMaxLen = 54): string {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const lines: string[] = [];

  for (const group of TOOL_GROUPS) {
    const st = groupStatus(group.id, enabled);
    const badge = st.status === "partial" ? `${st.on}/${st.total} on` : st.status;
    lines.push(`${group.id} [${badge}]: ${group.description}`);
    for (const name of group.tools) {
      const meta = byName.get(name);
      const summary = meta ? summarizeDescription(meta.description, summaryMaxLen) : "";
      const marker = st.status === "partial" ? (enabled.has(name) ? " [on]" : " [off]") : "";
      lines.push(`  ${name}${marker}: ${summary}`);
    }
  }

  lines.push("Enable: flow_tools({ enable: [\"group\" or \"tool\"] }) | Run directly: flow_call({ tool, arguments })");
  return lines.join("\n");
}

export interface SearchMatch {
  name: string;
  group: ToolGroupId;
  title: string;
  enabled: boolean;
  summary: string;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasWord(haystackTokens: readonly string[], word: string): boolean {
  return haystackTokens.includes(word);
}

export function searchTools(
  tools: readonly ToolMeta[],
  query: string,
  enabled: ReadonlySet<string> = new Set(),
  limit = 8,
): SearchMatch[] {
  const queryWords = tokenize(query);
  if (queryWords.length === 0) return [];
  const rawLower = query.trim().toLowerCase();

  const groupOrder = new Map<ToolGroupId, number>(ALL_GROUP_IDS.map((id, i) => [id, i]));
  const scored: { meta: ToolMeta; score: number }[] = [];

  for (const meta of tools) {
    const nameLower = meta.name.toLowerCase();
    const nameTokens = tokenize(meta.name);
    const titleLower = meta.title.toLowerCase();
    const titleTokens = tokenize(meta.title);
    const descLower = meta.description.toLowerCase();
    const descTokens = tokenize(meta.description);
    const paramNames = meta.params.map((p) => p.toLowerCase());
    const paramsJoined = paramNames.join(" ");
    const groupLower = meta.group.toLowerCase();

    // Every query word must appear somewhere in name, title, params, description, or group.
    let allPresent = true;
    let score = 0;

    if (rawLower === nameLower || `flow_${rawLower}` === nameLower) {
      score += 5000;
    }

    for (const word of queryWords) {
      const inName = nameLower.includes(word);
      const inTitle = titleLower.includes(word);
      const inParams = paramsJoined.includes(word);
      const inDesc = descLower.includes(word);
      const inGroup = groupLower.includes(word);

      if (!inName && !inTitle && !inParams && !inDesc && !inGroup) {
        allPresent = false;
        break;
      }

      // Deterministic tier separation: name > title > params > description > group.
      if (inName) {
        score += hasWord(nameTokens, word) ? 1000 : 600;
      } else if (inTitle) {
        score += hasWord(titleTokens, word) ? 200 : 120;
      } else if (inParams) {
        score += paramNames.some((p) => p === word || tokenize(p).includes(word)) ? 60 : 35;
      } else if (inDesc) {
        score += hasWord(descTokens, word) ? 20 : 10;
      } else {
        score += 5;
      }
    }

    if (allPresent) {
      scored.push({ meta, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ga = groupOrder.get(a.meta.group) ?? 99;
    const gb = groupOrder.get(b.meta.group) ?? 99;
    if (ga !== gb) return ga - gb;
    return a.meta.name.localeCompare(b.meta.name);
  });

  return scored.slice(0, limit).map(({ meta }) => ({
    name: meta.name,
    group: meta.group,
    title: meta.title,
    enabled: enabled.has(meta.name),
    summary: summarizeDescription(meta.description, 120),
  }));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export function closestNames(input: string, candidates: Iterable<string>, limit = 5): string[] {
  const q = input.trim().toLowerCase();
  const unique = [...new Set(candidates)];
  if (!q) return unique.slice(0, limit);
  const qStripped = q.replace(/^flow_/, "");

  const ranked = unique.map((name) => {
    const c = name.toLowerCase();
    const cStripped = c.replace(/^flow_/, "");
    let dist: number;
    if (q === c || (qStripped && qStripped === cStripped)) {
      dist = 0;
    } else if (c.includes(q) || (qStripped.length >= 2 && cStripped.includes(qStripped))) {
      dist = 0.5 + Math.abs(cStripped.length - qStripped.length) * 0.05;
    } else if (q.includes(c) || (cStripped.length >= 2 && qStripped.includes(cStripped))) {
      dist = 0.8 + Math.abs(qStripped.length - cStripped.length) * 0.05;
    } else {
      dist = Math.min(levenshtein(q, c), levenshtein(qStripped, cStripped));
    }
    return { name, dist };
  });

  ranked.sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.name.localeCompare(b.name)));
  return ranked.slice(0, limit).map((r) => r.name);
}

export interface ResolvedTargets {
  tools: string[];
  unknown: string[];
}

export function resolveTargets(targets: readonly string[], registeredToolNames: ReadonlySet<string>): ResolvedTargets {
  const tools: string[] = [];
  const seenTools = new Set<string>();
  const unknown: string[] = [];
  const seenUnknown = new Set<string>();

  const addTool = (name: string) => {
    if (!seenTools.has(name)) {
      seenTools.add(name);
      tools.push(name);
    }
  };

  for (const raw of targets) {
    const token = raw.trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (key === "all") {
      for (const name of ALL_GROUPED_TOOLS) addTool(name);
      continue;
    }
    const group = GROUP_BY_ID.get(key as ToolGroupId);
    if (group) {
      for (const name of group.tools) addTool(name);
      continue;
    }
    if (registeredToolNames.has(key)) {
      addTool(key);
      continue;
    }
    if (!seenUnknown.has(key)) {
      seenUnknown.add(key);
      unknown.push(token);
    }
  }

  return { tools, unknown };
}
