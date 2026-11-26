#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LocalCore, shapes, type Core } from "./core.js";
import { PLAYBOOK } from "./playbook.js";
import { RemoteCore } from "./remote.js";
import { PORT, startServer } from "./server.js";
import {
  ALL_GROUP_IDS,
  ALWAYS_ON_TOOLS,
  DISCOVERY_TOOLS,
  GROUP_BY_ID,
  SERVER_INSTRUCTIONS,
  TOOL_TO_GROUP,
  assertToolGroupCoverage,
  closestNames,
  formatGroupsOverview,
  groupStatus,
  parseToolsMode,
  resolveTargets,
  searchTools,
  summarizeDescription,
  type ToolGroupId,
  type ToolMeta,
} from "./toolsets.js";

const local = new LocalCore();
const role = await startServer(local);
const core: Core = role === "client" ? new RemoteCore() : local;
const studio = role === "none" ? undefined : `http://127.0.0.1:${PORT}`;

const server = new McpServer({ name: "flow-mcp", version: "0.2.0" }, { instructions: SERVER_INSTRUCTIONS });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ToolEntry = {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  params: string[];
  handle: RegisteredTool;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
};

const registry = new Map<string, ToolEntry>();

function tool<S extends z.ZodRawShape>(
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: S;
    annotations?: ToolAnnotations;
  },
  handler: (args: z.infer<z.ZodObject<S>>, extra: Parameters<ToolCallback<S>>[1]) => Promise<ToolResult> | ToolResult,
): RegisteredTool {
  const handle = server.registerTool(name, config, handler as ToolCallback<S>);
  registry.set(name, {
    name,
    title: config.title,
    description: config.description,
    schema: z.object(config.inputSchema),
    params: Object.keys(config.inputSchema),
    handle,
    handler: handler as ToolEntry["handler"],
  });
  return handle;
}
const reply = async (work: Promise<unknown>, extra: object = {}): Promise<ToolResult> => {
  try {
    const data = await work;
    const body = Array.isArray(data) ? data : { ...(data as object), ...extra };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }], isError: true };
  }
};

// Most AI apps stop waiting on a tool after about a minute (the MCP default, and Codex's), but Flow is often slower: a
// character edit takes one to two minutes. The work carried on while the app reported "Request timed out", so finished
// work looked failed - and a shot was once paid for twice. No call holds on longer than this now; anything slower hands
// back a task id and keeps going, and flow_wait collects the answer.
// FLOW_MCP_PATIENCE_MS lowers it for an app with a shorter limit (and lets a test reach the slow path quickly).
const PATIENCE_MS = Number(process.env.FLOW_MCP_PATIENCE_MS ?? 45_000);
const WAIT_MS = Math.max(5_000, PATIENCE_MS - 5_000);
type Task = { task_id: string; tool: string; started: string; status: "running" | "done" | "failed"; result?: unknown; error?: string };
const tasks = new Map<string, Task>();

const patient = async (tool: string, work: Promise<unknown>): Promise<unknown> => {
  const task: Task = { task_id: `task-${randomUUID().slice(0, 8)}`, tool, started: new Date().toISOString(), status: "running" };
  const settled = work.then(
    (result) => {
      task.status = "done";
      task.result = result;
    },
    (err) => {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), PATIENCE_MS)));
  const first = await Promise.race([settled.then(() => "settled" as const), late]);
  clearTimeout(timer);
  if (first === "settled") return work;
  tasks.set(task.task_id, task);
  return {
    still_working: true,
    task_id: task.task_id,
    note: `Flow is still on it - this is not a failure. Call flow_wait with job_ids ["${task.task_id}"] for the result, and do not call ${tool} again: the work has not stopped.`,
  };
};

// Task ids are answered from here, queued job ids by the queue; either way the call comes back inside the app's limit.
async function waitFor({ job_ids, timeout_seconds }: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
  const deadline = Date.now() + Math.min(timeout_seconds * 1000, WAIT_MS);
  const isTask = (id: string) => tasks.has(id) || id.startsWith("task-");
  const mine = (job_ids ?? []).filter(isTask);
  const jobs = job_ids?.filter((id) => !isTask(id));
  while (Date.now() < deadline && mine.some((id) => tasks.get(id)?.status === "running")) await new Promise((r) => setTimeout(r, 1000));
  // A task id this process never issued belongs to a tool process that has since restarted: its answer is gone, but the
  // work may well have happened, so say that instead of reporting it finished.
  const done = mine.map(
    (id) =>
      tasks.get(id) ?? {
        task_id: id,
        status: "unknown",
        note: "This tool restarted since that call, so its answer is lost. Check Flow (flow_assets, flow_characters) for what it did before running it again.",
      },
  );
  const tasksFinished = done.every((t) => t.status !== "running");
  if (mine.length && !jobs?.length) return { finished: tasksFinished, tasks: done };
  const left = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
  const queued = (await core.wait({ job_ids: jobs, timeout_seconds: left })) as { finished: boolean };
  return mine.length ? { ...queued, finished: queued.finished && tasksFinished, tasks: done } : queued;
}

tool(
  "flow_status",
  {
    title: "Flow status",
    description:
      "Check the Flow Chrome session (signed in, project open, plan, credits left) and the generation queue. Call this first; it says what the user must fix before generating, and returns the prompt playbook.",
    inputSchema: shapes.status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => {
    const hidden = [...registry.values()].filter((e) => !e.handle.enabled).length;
    const playbook =
      hidden > 0
        ? {
            ...PLAYBOOK,
            workflow: [
              ...PLAYBOOK.workflow,
              `${hidden} more tools (images, video, characters, projects, library, sound, film, music) are currently off; call flow_tools to search or switch them on, or flow_call to run one by name.`,
            ],
          }
        : PLAYBOOK;
    return reply(core.status(args), { studio, playbook, ...(tasks.size ? { slow_calls: [...tasks.values()].map(({ result, ...t }) => t) } : {}) });
  },
);

tool(
  "flow_generate",
  {
    title: "Queue Flow generations",
    description:
      "Queue one clip or image per scene in the open Flow project. Runs one at a time per account with human-like pauses (image scenes with parallel_images: sent one after another without waiting, then collected; with several accounts in flow_accounts, scenes are shared out and generate at the same time) and spends the user's Google AI credits (per video, at 720p: Omni 1.2 Flash 3 a second up to 10 s and 6 a second after, so 30 for 10 s and 60 for 15 s; at 360p a third of that; Veo 3.1 Lite 10; images 0). Each scene is checked against max_credits using Flow's own quote before anything is spent. Returns job ids immediately; use flow_wait for results.",
    inputSchema: shapes.generate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.generate(args)),
);

tool(
  "flow_wait",
  {
    title: "Wait for Flow jobs",
    description:
      "Wait for queued jobs (default: all), or for the task_id of a call that answered still_working, then return their status, results and file paths. Comes back within about 40 s even when they are still running: call again until finished is true.",
    inputSchema: shapes.wait,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(waitFor(args)),
);

tool(
  "flow_cancel",
  {
    title: "Cancel a queued Flow job",
    description: "Cancel a job that has not started yet. A running generation cannot be cancelled.",
    inputSchema: shapes.cancel,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  (args) => reply(core.cancel(args)),
);

tool(
  "flow_retry",
  {
    title: "Retry failed Flow jobs",
    description: "Put failed jobs back in the queue with the same settings and file names (default: all failed jobs). Scenes already retry once on their own when Flow reports a failure. An image batch that finished with some images still failed (its job lists failed_scenes) is not run again whole: only those images are made again, saved under their own scene numbers.",
    inputSchema: shapes.retry,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.retry(args)),
);

tool(
  "flow_assets",
  {
    title: "List project media",
    description:
      "List the images, videos, scenes, characters and collections in the open Flow project (title and kind). Titles can be used as 'asset:<title>' in flow_generate or with flow_download. Media filed inside the project's Library (collections, and collections inside them) is not in that flat list: pass recursive: true to walk the whole Library, or collection: '<path>' for one collection; items then carry their `path` and a `ref` for flow_download.",
    inputSchema: shapes.assets,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_assets", core.assets(args))),
);

tool(
  "flow_download",
  {
    title: "Download existing project media",
    description:
      "Download media that already exists in the Flow project, without regenerating it (no credits, including 1080p/2K upscales). Pass `assets` for individual items matched by title prefix, or by Library `ref` ('<collection path>/<title>' from flow_assets; a character's portrait is saved from its editor). Or pass `collection` to fetch a whole Flow collection as ONE ZIP of originals (each under its own title, e.g. an agent batch whose download stopped).",
    inputSchema: shapes.download,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_download", core.download(args))),
);

tool(
  "flow_agent_images",
  {
    title: "Fast image batch via Flow's agent",
    description:
      "Hand up to 50 image scenes to Flow's own Agent mode, which renders them all in parallel (minutes for a whole batch instead of one paced job per scene) and enriches each prompt itself. Images only, 0 credits. Pass `references` (characters, places, objects, each with a short name) to attach them once in the agent's composer, the way its + button does, and `scene_references` to say which scenes use which, so a whole story stays on-model. With several accounts enabled (flow_accounts) the batch is split between them and every account's agent works at the same time; files keep their scene numbers (a batch with 'asset:' references stays on the first account). Scenes the agent drops are asked for again, then made one by one with their references. The finished images are moved into one Flow collection (<folder>-<job id>) and downloaded as ONE ZIP of originals, not one by one; if that download stops, the job fails without making anything again and flow_download with `collection` fetches them. Less exact than flow_generate: the agent picks the wording, no techniques, and each image is matched back to its scene by its stored prompt. Returns job id(s); use flow_wait.",
    inputSchema: shapes.agent,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.agent(args)),
);

tool(
  "flow_cutout",
  {
    title: "Image with a transparent background",
    description:
      "Use whenever someone wants an image with no background, a transparent PNG, a cutout, a sticker or a logo to place on something else. Flow draws the subject on pure white, then redraws the same picture on pure black, and the two are compared pixel by pixel on this computer (difference matting), so hair, glass and soft edges keep real partial transparency instead of a hard cut. Give `prompt` to draw something new or `image` to cut out an existing picture. Two free images (0 credits). Returns two job ids; flow_wait the second one - its first file is the transparent <name>.png, and its note warns when the model changed the subject between the takes.",
    inputSchema: shapes.cutout,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.cutout(args)),
);

tool(
  "flow_edit",
  {
    title: "Edit an existing video",
    description:
      "Video-to-video edit of a clip already in the Flow project (relight, change weather/background, remove or restyle objects) using Flow's edit view. Queued like a generation; use flow_wait for the file. Spends credits without a prior quote (about 20 for a 4 s clip), so ask the user before calling.",
    inputSchema: shapes.edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.edit(args)),
);

tool(
  "flow_continue",
  {
    title: "Continue a clip, keeping a character attached",
    description:
      "Start a new clip from the last frame of one already in the project, for a continuous take across a cut. It saves the source clip's real final frame, animates it through Flow's agent mode, and downloads the result. mode 'exact' (default) gives an invisible join - the clip opens on the actual last frame - but attached characters are ignored, so the likeness must come from that frame; mode 'likeness' keeps a character or your avatar locked at the cost of an only-approximate opening frame. Flow cannot do both at once. Agent mode shows no credit quote beforehand, so ask the user before calling. Queued like a generation; use flow_wait for the file.",
    inputSchema: shapes.continue_shot,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_continue", core.continue_shot(args))),
);

tool(
  "flow_trash",
  {
    title: "Move an item to Flow's Trash",
    description:
      "Move one image, video or scene in the open Flow project to Flow's Trash, by its exact title from flow_assets. Recoverable: Flow keeps it in Trash with a Restore button. Never deletes permanently. Flow asks no confirmation of its own, so confirm with the user before calling. Refuses if two items share the title.",
    inputSchema: shapes.trash,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_trash", core.trash(args))),
);

tool(
  "flow_rename",
  {
    title: "Rename an item in the Flow project",
    description:
      "Rename one image, video or scene in the open Flow project, by its exact current title from flow_assets. Use it to put a name back when something ended up mislabelled. Refuses if two items share the current title, or if the new title is already taken.",
    inputSchema: shapes.rename,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_rename", core.rename(args))),
);

tool(
  "flow_character",
  {
    title: "Create a reusable character",
    description:
      "Create a reusable Flow character (person, mascot, product) so it looks the same in every scene. Free. Give `describe` and Flow draws the portrait first, or `image` to use a picture you already have; optionally a personality and a stock voice (or `voice_from` to copy another character's voice for an outfit variation). Reports the voice the character ended up with. Afterwards pass 'asset:<name>' in a scene's reference_images.",
    inputSchema: shapes.character,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character", core.character(args))),
);

tool(
  "flow_character_edit",
  {
    title: "Restyle an existing character",
    description:
      "Change how an existing character looks without creating a new one (Flow redraws the portrait in place, free), and save the new portrait to <films>/_cast. The character keeps its name, personality and voice, so every scene that references it picks up the new look. Also changes a character's voice with `voice` or `voice_from` (a voice-only call skips the portrait redraw). Pass `look` with the full updated description so scene prompts stop quoting the old one. With no `change` or voice it only saves the current portrait.",
    inputSchema: shapes.character_edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character_edit", core.character_edit(args))),
);

tool(
  "flow_projects",
  {
    title: "List Flow projects",
    description:
      "List the projects on the user's Flow home page without disturbing the currently open project tab, and mark which one is open. Characters, assets and generations are per project.",
    inputSchema: shapes.projects,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_projects", core.projects(args))),
);

tool(
  "flow_new_project",
  {
    title: "Start a new Flow project",
    description: "Create a new, empty Google Flow project and open it in the Flow window, optionally with a name - for starting a film or ad from scratch. Free. Characters belong to a project, so make them again in the new one.",
    inputSchema: shapes.new_project,
    annotations: { openWorldHint: true },
  },
  (args) => reply(patient("flow_new_project", core.new_project(args))),
);

tool(
  "flow_open_project",
  {
    title: "Open a Flow project",
    description:
      "Open one of the account's Flow projects in the Chrome window, by the name Flow shows (or its uuid/URL), so a run can carry on without the user clicking. flow_projects and flow_status list the names. Refuses a name that matches more than one project.",
    inputSchema: shapes.open_project,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_open_project", core.open_project(args))),
);

tool(
  "flow_rename_project",
  {
    title: "Rename the open Flow project",
    description:
      "Rename the currently open Google Flow project from the project grid (1 to 100 characters, single line) and confirm Flow kept the new title. Free.",
    inputSchema: shapes.rename_project,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_rename_project", core.rename_project(args))),
);

tool(
  "flow_characters",
  {
    title: "List characters",
    description:
      "List the reusable characters in the open Flow project, with their remembered voices (pass `with_voices: true` to read each voice live from Flow, ~8 s per character). Each can be used in a scene as 'asset:<name>'. Pass `include_library: true` to also list characters filed in Library collections, with a `ref` for flow_download.",
    inputSchema: shapes.characters,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_characters", core.characters(args))),
);

tool(
  "flow_accounts",
  {
    title: "Flow accounts working in parallel",
    description:
      "Several Google accounts can drive Flow at the same time, each in its own Chrome window with its own project: queued work (flow_generate scenes, flow_agent_images batches, flow_cutout takes) is shared out and every account generates at once, one job at a time each. action list (default) shows each account: signed in, project open, busy. add creates an account and opens its Chrome on Flow - the user signs in to Google there BY HAND (never type credentials for them) and opens a project. open brings an account's window up; enable / disable lets an account take work or not. Media already in a Flow project (asset:..., edits, continuations, characters) lives in one account's project, so that work goes to the first account unless `account` is passed.",
    inputSchema: shapes.accounts,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_accounts", core.accounts(args))),
);

tool(
  "flow_image_models",
  {
    title: "Image models and the default one",
    description:
      "List the image models Flow offers right now (read from Flow's own menu) and which one image jobs use when they name none. Pass set_default to save the user's choice, e.g. 'Nano Banana Pro'; it then applies to flow_generate image scenes, flow_agent_images and flow_cutout until changed. 'latest' goes back to always using the newest Nano Banana. Any single call can still name its own `model`. Ask the user which model they want before setting it.",
    inputSchema: shapes.image_models,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_image_models", core.image_models(args))),
);

tool(
  "flow_techniques",
  {
    title: "Film technique presets",
    description:
      "List ready-made prompt phrases for camera moves, product shots, first→last-frame transitions and image commands. Pass an id as a scene's `technique` in flow_generate.",
    inputSchema: shapes.techniques,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(core.techniques(args)),
);

tool(
  "flow_narrate",
  {
    title: "Record narration",
    description:
      "Record narration as an .m4a, free. The default `engine: \"kokoro\"` is Kokoro, a voice that runs on this computer: no key, no daily limit, any length, 28 English voices (flow_voices lists them; default am_michael) and a `speed`. The first Kokoro take downloads its model once (326 MB, about a minute). `engine: \"gemini\"` uses Google AI Studio's text-to-speech (the same voices Flow has, a free key in ~/.flow-mcp/gemini-key, a daily limit, takes a short `style` note); if that limit is used up the line is recorded with Kokoro and the result says so. Neither costs credits. Record a whole narration in one take; flow_assemble can lay it over a film.",
    inputSchema: shapes.narrate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_narrate", core.narrate(args))),
);

tool(
  "flow_voices",
  {
    title: "List Flow voices",
    description: "Narrator voices available for flow_narrate: Kokoro's (free, on this computer, with whether its model is downloaded yet) and Google AI Studio's (with whether a key is set up).",
    inputSchema: shapes.voices,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => reply(core.voices()),
);

tool(
  "flow_assemble",
  {
    title: "Assemble clips into one video",
    description:
      "Join a project's downloaded scene clips in order into one MP4 (local ffmpeg, no credits). Keeps each clip's own sound and can lay a music track and a voiceover on top.",
    inputSchema: shapes.assemble,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(patient("flow_assemble", core.assemble(args))),
);

tool(
  "flow_transcribe",
  {
    title: "Hear the words in a video or audio file",
    description:
      "Transcribe a video or audio file on this computer with every word's start and end time (whisper.cpp, local and free, about 100 languages; pass `language` when you know it. The first call in English downloads a 148 MB speech model once, in any other language a 574 MB one). Use the times to check a take said the right words and to cut lines out of it for flow_assemble's voice_lines.",
    inputSchema: shapes.transcribe,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (args) => reply(patient("flow_transcribe", core.transcribe(args))),
);

tool(
  "flow_captions",
  {
    title: "Add captions to a video",
    description:
      "Burn spoken-word captions into a video, in the style short-form apps use, for landscape or vertical footage (local and free: whisper.cpp hears the words on this computer, nothing is uploaded). Styles: bold (big capitals, the spoken word lights up), highlight, reveal, clean, boxed. Works in about 100 languages, including ones written without spaces (Japanese, Chinese, Thai) and right to left (Arabic, Hebrew); pass `language` (en, es, tr, ja...) whenever you know it. The first call downloads a speech model once: 148 MB for English, 574 MB for other languages. Saves <name>-captions.mp4 plus an .srt. Before calling this, call flow_transcribe, show the user the words with any likely mishearings fixed, and get their OK: then pass the agreed words as `text` (matching words keep their timing), so the video is made once, right.",
    inputSchema: shapes.captions,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  (args) => reply(patient("flow_captions", core.captions(args))),
);

tool(
  "flow_presenter",
  {
    title: "Talking presenter over footage",
    description:
      "Build an explainer from one recording of a talking presenter (an avatar video, say): each stretch shows them full frame, with an optional slow zoom, or in a circle in a corner over another clip. Their sound plays throughout. Local and free. Add music, loudness and watermark removal afterwards with flow_assemble.",
    inputSchema: shapes.presenter,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  (args) => reply(patient("flow_presenter", core.presenter(args))),
);

tool(
  "flow_music_status",
  {
    title: "Check Flow Music session, credits, and music lane",
    description:
      "Check whether the Flow Music window (https://www.flowmusic.app/) is signed in, its plan tier and credit balance (read from the page's own responses; skips reload while a song is generating), and what the music queue lane is doing.",
    inputSchema: shapes.music_status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_music_status", core.music_status(args))),
);

tool(
  "flow_music",
  {
    title: "Generate songs in Google Flow Music",
    description:
      "Queue one or more songs through Google Flow Music's compose panel (Lyria 3.5 / Lyria 3 Pro) on the separate music lane, so songs run alongside Flow video/image jobs without waiting behind them. Saves <output>/<project>/song-NN.<ext> (default format m4a; mp3 and wav also supported; length_seconds 60 to 180 / 1:00 to 3:00; instrumental defaults to true when lyrics are omitted). Credit guard: Flow Music shows NO price before generating (observed price: 5 credits per song). max_credits defaults to 10 and must be at least 5 or the song is refused before anything is typed; the account's credit balance is also checked before generating (refused if under 5). Spend is measured from the balance before minus after: if a song costs more than max_credits, it finishes with a warning note and every remaining queued music job is failed so nothing more starts. Use flow_wait, flow_status, flow_cancel, and flow_retry like other jobs.",
    inputSchema: shapes.music,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.music(args)),
);

tool(
  "flow_music_songs",
  {
    title: "List songs in Flow Music library",
    description:
      "List songs from your Flow Music library (/library/my-songs), newest first, returning clip id, title, length in seconds, creation time, and the start of the sound description. Use the returned id or exact title with flow_music_download.",
    inputSchema: shapes.music_songs,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_music_songs", core.music_songs(args))),
);

tool(
  "flow_music_download",
  {
    title: "Download existing songs from Flow Music",
    description:
      "Download existing songs from your Flow Music library by clip id or exact title in the requested formats (m4a, mp3, wav; default m4a). Free; never regenerates. Refuses an ambiguous title and lists the matching clip ids so you can pass an id instead.",
    inputSchema: shapes.music_download,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_music_download", core.music_download(args))),
);

const flowToolsShape = {
  query: z.string().min(1).optional().describe("Search tools by keywords across names, titles, descriptions, and parameters (all words must match)."),
  group: z.string().min(1).optional().describe("Inspect one group by name (e.g. 'music', 'film', 'characters')."),
  enable: z.array(z.string().min(1)).optional().describe("Group or tool names to switch on for this session (e.g. ['music'] or ['flow_assemble'])."),
  disable: z.array(z.string().min(1)).optional().describe("Group or tool names to switch off again (core, flow_tools, and flow_call stay on)."),
};

const flowCallShape = {
  tool: z.string().min(1).describe("Exact tool name, e.g. 'flow_assemble' or 'flow_music'."),
  arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments object for that tool, matching its input schema."),
};

const toJsonSchema = (schema: z.ZodObject<z.ZodRawShape>) =>
  z.toJSONSchema(schema, { target: "draft-7", io: "input" });

const formatZodIssues = (issues: z.core.$ZodIssue[]) =>
  issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");

const getToolMetas = (): ToolMeta[] =>
  [...registry.values()].map((e) => ({
    name: e.name,
    group: TOOL_TO_GROUP.get(e.name)!,
    title: e.title,
    description: e.description,
    params: e.params,
  }));

const getEnabledNames = (): Set<string> => {
  const out = new Set<string>(DISCOVERY_TOOLS);
  for (const [name, entry] of registry) {
    if (entry.handle.enabled) out.add(name);
  }
  return out;
};

function handleFlowTools({
  query,
  group,
  enable,
  disable,
}: z.infer<z.ZodObject<typeof flowToolsShape>>): ToolResult {
  const hasEnable = Boolean(enable && enable.length > 0);
  const hasDisable = Boolean(disable && disable.length > 0);
  if (!query && !group && !hasEnable && !hasDisable) {
    return { content: [{ type: "text", text: formatGroupsOverview(getToolMetas(), getEnabledNames()) }] };
  }

  const allTargets = new Set<string>([...registry.keys(), ...DISCOVERY_TOOLS]);
  const allCandidates = [...ALL_GROUP_IDS, ...registry.keys()];
  const out: Record<string, unknown> = {};
  const unknownTargets: string[] = [];
  let changed = false;
  let handledSomething = false;

  if (hasEnable && enable) {
    const resolved = resolveTargets(enable, allTargets);
    const switchedOn: string[] = [];
    const alreadyOn: string[] = [];
    const details: { name: string; group: ToolGroupId; title: string; description: string; inputSchema: unknown }[] = [];

    for (const name of resolved.tools) {
      if ((DISCOVERY_TOOLS as readonly string[]).includes(name)) {
        alreadyOn.push(name);
        continue;
      }
      const entry = registry.get(name);
      if (!entry) continue;
      if (!entry.handle.enabled) {
        // Mutate enabled directly so a batch emits one tools/list_changed notification instead of one per tool.
        entry.handle.enabled = true;
        changed = true;
        switchedOn.push(name);
      } else {
        alreadyOn.push(name);
      }
      details.push({
        name: entry.name,
        group: TOOL_TO_GROUP.get(entry.name)!,
        title: entry.title,
        description: entry.description,
        inputSchema: toJsonSchema(entry.schema),
      });
    }

    if (details.length > 0 || alreadyOn.length > 0) {
      handledSomething = true;
      out.note = "If your app does not refresh its tool list automatically, call any of these tools right away through flow_call using the schemas below.";
      out.enabled = switchedOn;
      if (alreadyOn.length) out.already_on = alreadyOn;
      out.tools = details;
    }
    for (const u of resolved.unknown) unknownTargets.push(u);
  }

  if (hasDisable && disable) {
    const resolved = resolveTargets(disable, allTargets);
    const switchedOff: string[] = [];
    const alreadyOff: string[] = [];
    const keptOn: string[] = [];

    for (const name of resolved.tools) {
      if (ALWAYS_ON_TOOLS.has(name)) {
        keptOn.push(name);
        continue;
      }
      const entry = registry.get(name);
      if (!entry) continue;
      if (entry.handle.enabled) {
        entry.handle.enabled = false;
        changed = true;
        switchedOff.push(name);
      } else {
        alreadyOff.push(name);
      }
    }

    if (switchedOff.length > 0 || alreadyOff.length > 0 || keptOn.length > 0) {
      handledSomething = true;
      out.disabled = switchedOff;
      if (alreadyOff.length) out.already_off = alreadyOff;
      if (keptOn.length) {
        out.kept_on = keptOn;
        out.kept_on_note = "core, flow_tools, and flow_call stay on and cannot be disabled.";
      }
    }
    for (const u of resolved.unknown) unknownTargets.push(u);
  }

  if (changed) {
    server.sendToolListChanged();
  }

  if (unknownTargets.length) {
    const uniqueUnknown = [...new Set(unknownTargets)];
    out.unknown = uniqueUnknown.map((name) => ({ name, closest: closestNames(name, allCandidates) }));
  }

  if (group) {
    const g = GROUP_BY_ID.get(group.trim().toLowerCase() as ToolGroupId);
    if (!g) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Unknown group "${group}". Valid groups: ${ALL_GROUP_IDS.join(", ")}.`,
                closest: closestNames(group, ALL_GROUP_IDS),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    handledSomething = true;
    const enabled = getEnabledNames();
    const st = groupStatus(g.id, enabled);
    out.group = {
      id: g.id,
      description: g.description,
      status: st.status,
      tools: g.tools.map((name) => {
        const entry = registry.get(name)!;
        return {
          name,
          title: entry.title,
          enabled: entry.handle.enabled,
          summary: summarizeDescription(entry.description, 120),
        };
      }),
    };
  }

  if (query) {
    handledSomething = true;
    const matches = searchTools(getToolMetas(), query, getEnabledNames());
    out.query = query;
    out.matches = matches;
    if (matches.length === 0) {
      out.search_note = "No tools matched all query words. Call flow_tools with no arguments to see all groups.";
    }
  }

  if (!handledSomething && unknownTargets.length) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: `Unknown tool or group name(s): ${unknownTargets.join(", ")}.`,
              unknown: out.unknown,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
}

server.registerTool(
  "flow_tools",
  {
    title: "Discover or switch Flow tool groups",
    description:
      "List, search, enable, or disable flow-mcp tool groups for this session. Call with no arguments to list all groups (core, images, video, characters, projects, library, sound, film, music) and one-line tool summaries; pass query to search by keyword; pass group to inspect one group; pass enable or disable with group or tool names (core and discovery tools stay on). Enabling returns full descriptions and JSON Schemas so you can also call tools immediately via flow_call.",
    inputSchema: flowToolsShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => handleFlowTools(args),
);

server.registerTool(
  "flow_call",
  {
    title: "Run any Flow tool by name",
    description:
      "Run any flow-mcp tool by name whether or not it is currently listed, using its normal input validation and handler. Use this only for tools found with flow_tools that your app has not listed yet; call listed tools directly instead.",
    inputSchema: flowCallShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ tool: toolName, arguments: rawArgs }, extra) => {
    const name = toolName.trim();
    if (name === "flow_call") {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "flow_call cannot call itself. Pass another flow-mcp tool name." }, null, 2) }],
        isError: true,
      };
    }
    if (name === "flow_tools") {
      const parsed = await z.object(flowToolsShape).safeParseAsync(rawArgs ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Invalid arguments for tool ${name}: ${formatZodIssues(parsed.error.issues)}` }, null, 2) }],
          isError: true,
        };
      }
      return handleFlowTools(parsed.data);
    }
    const entry = registry.get(name);
    if (!entry) {
      const closest = closestNames(name, [...registry.keys(), "flow_tools"]);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Unknown tool "${name}". Closest matches: ${closest.join(", ")}.`,
                closest,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const parsed = await entry.schema.safeParseAsync(rawArgs ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Invalid arguments for tool ${name}: ${formatZodIssues(parsed.error.issues)}` }, null, 2) }],
        isError: true,
      };
    }
    return entry.handler(parsed.data as Record<string, unknown>, extra);
  },
);

assertToolGroupCoverage(registry.keys());

const toolsMode = parseToolsMode(process.env.FLOW_MCP_TOOLS);
if (toolsMode.unknown.length > 0) {
  process.stderr.write(
    `[flow-mcp] Unknown FLOW_MCP_TOOLS group(s) ignored: ${toolsMode.unknown.join(", ")}. Valid groups: ${ALL_GROUP_IDS.join(", ")}.\n`,
  );
}
for (const [name, entry] of registry) {
  const group = TOOL_TO_GROUP.get(name)!;
  if (!toolsMode.enabledGroups.has(group)) {
    entry.handle.disable();
  }
}

await server.connect(new StdioServerTransport());
