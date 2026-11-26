import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ALL_GROUPED_TOOLS,
  ALL_GROUP_IDS,
  DISCOVERY_TOOLS,
  GROUP_BY_ID,
  TOOL_GROUPS,
  TOOL_TO_GROUP,
  assertToolGroupCoverage,
  closestNames,
  formatGroupsOverview,
  parseToolsMode,
  resolveTargets,
  searchTools,
  summarizeDescription,
} from "../dist/toolsets.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INDEX_TS = join(ROOT, "src", "index.ts");
const INDEX_JS = join(ROOT, "dist", "index.js");
const TMP_BASE = process.env.FLOW_MCP_TMP || tmpdir();

function tempDir(prefix) {
  mkdirSync(TMP_BASE, { recursive: true });
  return mkdtempSync(join(TMP_BASE, prefix));
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolvePort(port));
    });
  });
}

function readRegisteredToolsFromSource() {
  const src = readFileSync(INDEX_TS, "utf8");
  const domainTools = [];
  const discoveryTools = [];
  const toolRe = /\btool\(\s*"([^"]+)",\s*\{[\s\S]*?title:\s*"([^"]+)",[\s\S]*?description:\s*\r?\n?\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = toolRe.exec(src))) {
    domainTools.push({
      name: m[1],
      title: m[2],
      description: JSON.parse(`"${m[3]}"`),
    });
  }
  const directRe = /server\.registerTool\(\s*"([^"]+)"/g;
  while ((m = directRe.exec(src))) {
    discoveryTools.push(m[1]);
  }
  return { domainTools, discoveryTools };
}

test("parseToolsMode handles unset, progressive, all, lists, unknown names, spaces, and case", () => {
  const unset = parseToolsMode(undefined);
  assert.equal(unset.mode, "progressive");
  assert.deepEqual([...unset.enabledGroups], ["core"]);
  assert.deepEqual(unset.unknown, []);

  const empty = parseToolsMode("   ");
  assert.equal(empty.mode, "progressive");
  assert.deepEqual([...empty.enabledGroups], ["core"]);

  const prog = parseToolsMode("  PROGRESSIVE ");
  assert.equal(prog.mode, "progressive");
  assert.deepEqual([...prog.enabledGroups], ["core"]);

  const all = parseToolsMode(" ALL ");
  assert.equal(all.mode, "all");
  assert.deepEqual([...all.enabledGroups], [...ALL_GROUP_IDS]);
  assert.deepEqual(all.unknown, []);

  const list = parseToolsMode(" music , FILM , ");
  assert.equal(list.mode, "custom");
  assert.equal(list.enabledGroups.has("core"), true, "core is always enabled even when omitted");
  assert.equal(list.enabledGroups.has("music"), true);
  assert.equal(list.enabledGroups.has("film"), true);
  assert.equal(list.enabledGroups.has("video"), false);
  assert.deepEqual(list.unknown, []);

  const withUnknown = parseToolsMode("Sound, nope, NOPE, bogus, library");
  assert.equal(withUnknown.mode, "custom");
  assert.equal(withUnknown.enabledGroups.has("core"), true);
  assert.equal(withUnknown.enabledGroups.has("sound"), true);
  assert.equal(withUnknown.enabledGroups.has("library"), true);
  assert.deepEqual(withUnknown.unknown, ["nope", "bogus"]);
});

test("every tool in src/index.ts belongs to exactly one group and every group entry is registered", () => {
  const { domainTools, discoveryTools } = readRegisteredToolsFromSource();
  assert.equal(domainTools.length, 33, "expected 33 grouped domain tools in src/index.ts");
  assert.deepEqual([...discoveryTools].sort(), [...DISCOVERY_TOOLS].sort());

  // Verify no duplicates across TOOL_GROUPS.
  const seen = new Set();
  for (const g of TOOL_GROUPS) {
    for (const name of g.tools) {
      assert.equal(seen.has(name), false, `duplicate tool ${name} in TOOL_GROUPS`);
      seen.add(name);
    }
  }
  assert.equal(seen.size, ALL_GROUPED_TOOLS.length);

  // Verify exact 1-to-1 match with src/index.ts.
  assert.doesNotThrow(() => assertToolGroupCoverage(domainTools.map((t) => t.name)));

  // Verify assertToolGroupCoverage catches both missing and ungrouped tools.
  assert.throws(() => assertToolGroupCoverage([...domainTools.map((t) => t.name), "flow_unmapped"]), /missing from TOOL_GROUPS/);
  assert.throws(() => assertToolGroupCoverage(domainTools.slice(1).map((t) => t.name)), /not registered/);
});

test("searchTools ranks name > title > params > description and requires all query words", () => {
  const sample = [
    {
      name: "flow_alpha",
      group: "core",
      title: "Ordinary tool",
      description: "Mention of caption rendering in the body text.",
      params: ["project"],
    },
    {
      name: "flow_beta",
      group: "film",
      title: "Caption styler",
      description: "Styles words on screen.",
      params: ["video"],
    },
    {
      name: "flow_caption_maker",
      group: "film",
      title: "Video helper",
      description: "Processes clips.",
      params: ["video"],
    },
    {
      name: "flow_gamma",
      group: "sound",
      title: "Audio tool",
      description: "Handles audio tracks.",
      params: ["caption_text", "language"],
    },
  ];

  const ranked = searchTools(sample, "caption", new Set(["flow_alpha"]));
  assert.deepEqual(
    ranked.map((r) => r.name),
    ["flow_caption_maker", "flow_beta", "flow_gamma", "flow_alpha"],
  );
  assert.equal(ranked[3].enabled, true);
  assert.equal(ranked[0].enabled, false);

  // All query words must appear somewhere.
  const both = searchTools(sample, "caption language");
  assert.deepEqual(both.map((r) => r.name), ["flow_gamma"]);

  const none = searchTools(sample, "caption nonexistentword");
  assert.deepEqual(none, []);

  // Limit caps at 8.
  const many = Array.from({ length: 12 }, (_, i) => ({
    name: `flow_item_${String(i).padStart(2, "0")}`,
    group: "core",
    title: "Item",
    description: "Common keyword here.",
    params: [],
  }));
  assert.equal(searchTools(many, "common").length, 8);
});

test("no-argument overview stays strictly under 3 KB and lists every group and tool", () => {
  const { domainTools } = readRegisteredToolsFromSource();
  const metas = domainTools.map((t) => ({
    ...t,
    group: TOOL_TO_GROUP.get(t.name),
    params: [],
  }));
  const coreEnabled = new Set([...GROUP_BY_ID.get("core").tools, ...DISCOVERY_TOOLS]);
  const overview = formatGroupsOverview(metas, coreEnabled);
  const bytes = Buffer.byteLength(overview, "utf8");
  assert.ok(bytes < 3072, `expected overview under 3072 bytes, got ${bytes}`);

  for (const g of TOOL_GROUPS) {
    assert.ok(overview.includes(`${g.id} [`), `overview should list group ${g.id}`);
    for (const name of g.tools) {
      assert.ok(overview.includes(`${name}:`), `overview should list tool ${name}`);
    }
  }

  // summarizeDescription extracts the first sentence and respects maxLen.
  const summary = summarizeDescription("First sentence here (with a long aside about e.g. details). Second sentence ignored.", 120);
  assert.equal(summary, "First sentence here (with a long aside about e.g. details).");
  const shortSummary = summarizeDescription("First sentence here (with a long aside about details). Second sentence ignored.", 40);
  assert.ok(shortSummary.length <= 40);
  assert.equal(shortSummary, "First sentence here.");
});

test("closestNames suggests typos and unprefixed names, and resolveTargets expands groups", () => {
  const candidates = [...ALL_GROUP_IDS, ...ALL_GROUPED_TOOLS];
  assert.equal(closestNames("flow_assemle", ALL_GROUPED_TOOLS)[0], "flow_assemble");
  assert.equal(closestNames("cutout", ALL_GROUPED_TOOLS)[0], "flow_cutout");
  assert.equal(closestNames("musci", ALL_GROUP_IDS)[0], "music");

  const resolved = resolveTargets(["music", "flow_assemble", "flow_music", "bogus"], new Set(ALL_GROUPED_TOOLS));
  assert.deepEqual(resolved.tools, [
    "flow_music_status",
    "flow_music",
    "flow_music_songs",
    "flow_music_download",
    "flow_assemble",
  ]);
  assert.deepEqual(resolved.unknown, ["bogus"]);
  assert.ok(candidates.includes("flow_assemble"));
});

async function connectServer(envOverrides = {}) {
  const rootTmp = tempDir("flow-mcp-e2e-");
  const home = join(rootTmp, "home");
  const outDir = join(rootTmp, "out");
  const port = await getFreePort();
  const cdpPort = await getFreePort();

  const env = {
    ...process.env,
    FLOW_MCP_HOME: home,
    FLOW_MCP_PORT: String(port),
    FLOW_MCP_CDP_PORT: String(cdpPort),
    FLOW_MCP_OUTPUT: outDir,
    ...envOverrides,
  };
  if (envOverrides.FLOW_MCP_TOOLS === undefined) {
    delete env.FLOW_MCP_TOOLS;
  }

  let stderrText = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_JS],
    cwd: ROOT,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderrText += chunk.toString();
  });

  const client = new Client({ name: "flow-mcp-test-client", version: "1.0.0" });
  const listChangedEvents = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, (note) => {
    listChangedEvents.push(note);
  });

  await client.connect(transport);
  return {
    client,
    listChangedEvents,
    getStderr: () => stderrText,
    async cleanup() {
      try {
        await client.close();
      } catch {
        // Already closed.
      }
      rmSync(rootTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

test("MCP server progressive discovery end-to-end (default, enable/disable, flow_call, all, custom)", async () => {
  // 1. Default mode (FLOW_MCP_TOOLS unset)
  const session = await connectServer();
  try {
    const instructions = session.client.getInstructions();
    assert.ok(instructions && instructions.includes("flow_tools") && instructions.includes("flow_call"));

    const initialList = await session.client.listTools();
    const initialNames = initialList.tools.map((t) => t.name).sort();
    const expectedCore = [...GROUP_BY_ID.get("core").tools, ...DISCOVERY_TOOLS].sort();
    assert.deepEqual(initialNames, expectedCore);

    const defaultBytes = Buffer.byteLength(JSON.stringify(initialList), "utf8");
    assert.ok(defaultBytes < 16384, `default tools/list should be under 16 KB, got ${defaultBytes} bytes`);

    // No-argument flow_tools overview stays under 3 KB.
    const overviewRes = await session.client.callTool({ name: "flow_tools", arguments: {} });
    assert.ok(!overviewRes.isError);
    const overviewText = overviewRes.content[0].text;
    assert.ok(Buffer.byteLength(overviewText, "utf8") < 3072);
    assert.ok(overviewText.includes("video [off]:"));

    // Calling a disabled tool directly is refused by the SDK.
    const directOff = await session.client.callTool({ name: "flow_techniques", arguments: { category: "camera" } });
    assert.equal(directOff.isError, true);

    // Calling a disabled tool via flow_call succeeds and matches calling it directly once enabled.
    const viaCallOff = await session.client.callTool({
      name: "flow_call",
      arguments: { tool: "flow_techniques", arguments: { category: "camera" } },
    });
    assert.ok(!viaCallOff.isError);

    // Also verify flow_voices works without Chrome via flow_call.
    const voicesViaCall = await session.client.callTool({
      name: "flow_call",
      arguments: { tool: "flow_voices", arguments: {} },
    });
    assert.ok(!voicesViaCall.isError);
    const voicesParsed = JSON.parse(voicesViaCall.content[0].text);
    assert.ok(Array.isArray(voicesParsed.kokoro) && voicesParsed.kokoro.length > 0);

    // flow_call refuses bad arguments with the validation message.
    const badArgs = await session.client.callTool({
      name: "flow_call",
      arguments: { tool: "flow_techniques", arguments: { category: "not_a_category" } },
    });
    assert.equal(badArgs.isError, true);
    assert.match(badArgs.content[0].text, /Invalid arguments for tool flow_techniques/i);

    // flow_call refuses unknown tool names with closest suggestions.
    const unknownTool = await session.client.callTool({
      name: "flow_call",
      arguments: { tool: "flow_assemle", arguments: {} },
    });
    assert.equal(unknownTool.isError, true);
    assert.ok(unknownTool.content[0].text.includes("flow_assemble"));

    // Enable video group via flow_tools: sends one list_changed notification and returns schemas.
    const notificationsBefore = session.listChangedEvents.length;
    const enableRes = await session.client.callTool({
      name: "flow_tools",
      arguments: { enable: ["video"] },
    });
    assert.ok(!enableRes.isError);
    const enableBody = JSON.parse(enableRes.content[0].text);
    assert.deepEqual(enableBody.enabled, ["flow_edit", "flow_continue", "flow_techniques"]);
    assert.ok(typeof enableBody.note === "string" && enableBody.note.includes("flow_call"));
    assert.equal(enableBody.tools.length, 3);
    const techSchemaEntry = enableBody.tools.find((t) => t.name === "flow_techniques");
    assert.ok(techSchemaEntry?.description && techSchemaEntry?.inputSchema?.type === "object");

    // Wait briefly for the notification over stdio, then check it fired exactly once.
    for (let i = 0; i < 20 && session.listChangedEvents.length === notificationsBefore; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(session.listChangedEvents.length - notificationsBefore, 1, "batch enable should send one list_changed notification");

    const afterEnableList = await session.client.listTools();
    const afterEnableNames = new Set(afterEnableList.tools.map((t) => t.name));
    assert.equal(afterEnableNames.has("flow_techniques"), true);
    assert.equal(afterEnableNames.has("flow_edit"), true);
    assert.equal(afterEnableNames.has("flow_continue"), true);

    // Direct call to flow_techniques now succeeds with the exact same result as flow_call earlier.
    const directOn = await session.client.callTool({ name: "flow_techniques", arguments: { category: "camera" } });
    assert.ok(!directOn.isError);
    assert.deepEqual(directOn.content, viaCallOff.content);

    // Disabling core / discovery tools keeps them on while disabling video succeeds.
    const disableRes = await session.client.callTool({
      name: "flow_tools",
      arguments: { disable: ["core", "flow_tools", "flow_call", "video"] },
    });
    assert.ok(!disableRes.isError);
    const disableBody = JSON.parse(disableRes.content[0].text);
    assert.deepEqual(disableBody.disabled, ["flow_edit", "flow_continue", "flow_techniques"]);
    assert.ok(disableBody.kept_on.includes("flow_status"));
    assert.ok(disableBody.kept_on.includes("flow_tools"));
    assert.ok(disableBody.kept_on.includes("flow_call"));

    const afterDisableList = await session.client.listTools();
    assert.deepEqual(afterDisableList.tools.map((t) => t.name).sort(), expectedCore);
  } finally {
    await session.cleanup();
  }

  // 2. FLOW_MCP_TOOLS=all lists all 35 tools
  const allSession = await connectServer({ FLOW_MCP_TOOLS: "all" });
  try {
    const allList = await allSession.client.listTools();
    assert.equal(allList.tools.length, 35);
  } finally {
    await allSession.cleanup();
  }

  // 3. Custom list with an unknown group warns on stderr and still starts cleanly
  const customSession = await connectServer({ FLOW_MCP_TOOLS: "music,not_a_group" });
  try {
    const customList = await customSession.client.listTools();
    const expected = [...GROUP_BY_ID.get("core").tools, ...GROUP_BY_ID.get("music").tools, ...DISCOVERY_TOOLS].sort();
    assert.deepEqual(customList.tools.map((t) => t.name).sort(), expected);
    assert.match(customSession.getStderr(), /not_a_group/);
  } finally {
    await customSession.cleanup();
  }
});
