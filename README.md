# flow-mcp

Drive **Google Flow** (flow.google.com) from Claude, Codex or any other MCP app, or from a local control
panel, using Flow's own credits (free with any Google account: 50 a day), not the pay-per-use video API.

It is a small program that runs on your own machine. It opens its own Chrome window, signs in
as you, and clicks Flow's real buttons. There is no browser extension, no hosted service and no
account to create.

```
Claude / Codex ──stdio──> flow-mcp ──Chrome DevTools Protocol──> Chrome (its own profile) ──> Flow
```

**MCP** = Model Context Protocol, the standard that lets Claude use outside tools.
New here? [GETTING-STARTED.md](GETTING-STARTED.md) takes you from nothing to your first video, step by step, and
[OVERVIEW.md](OVERVIEW.md) explains what it does in plain English, with no code names.

> **About this repository.** It continues [GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp), where no community
> pull request has been merged. It carries that project's work up to 21 November 2026, the community pull requests
> that were waiting there (reviewed and fixed first), and fixes of its own. Issues and pull requests are welcome
> here. See [What this continuation adds](#what-this-continuation-adds).

---

## What you need

| | |
|---|---|
| **macOS, Windows 10/11 or Linux** | Runs on macOS, Windows and Linux. On Linux, Chrome and Chromium are found where distributions put them, deletes go to the freedesktop Trash, and the panel starts with `Flow Studio.sh`. Please report anything that breaks |
| **Node.js 22 or newer** | `node --version` |
| **Google Chrome** | Any recent version. On Linux, Chromium is used if Chrome is not installed (`FLOW_MCP_CHROME` picks a specific build), but real Chrome is what Flow was mapped against and what Google's sign-in trusts |
| **A Google account** | Free. Flow gives every account 50 credits a day; a paid Google AI plan adds more and unlocks 1080p downloads. Developed on a Pro plan |
| **FFmpeg** *(optional)* | Mac: `brew install ffmpeg` · Windows: `winget install Gyan.FFmpeg` · Linux: `sudo apt install ffmpeg`. Needed only to join clips, mix music or record narration |
| **A Google AI Studio key** *(optional, free)* | Only for the Google narration voices. See below |
| **whisper.cpp** *(optional, free)* | Only for captions: it hears the words, on your computer. Mac: `brew install whisper-cpp` · Windows: there is no installer — download `whisper-blas-bin-x64.zip` from [the whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases) (if the newest release has no Windows zip, take the latest release that does), extract `whisper-cli.exe` from its `Release` folder, and either put it on your PATH or point `FLOW_MCP_WHISPER` straight at the `.exe` · Linux: `sudo apt install whisper.cpp` (Debian, Ubuntu and Kali package it; `FLOW_MCP_WHISPER` points at it if your distribution names the binary differently). The speech model it needs downloads by itself the first time you caption a video: 148 MB for English, 574 MB for any other language |

A display must stay awake: the Chrome window is really being driven, so the machine cannot be
headless or asleep mid-run.

---

## Install

```bash
git clone https://github.com/Pho3niX90/flow-mcp.git
cd flow-mcp
npm install
npm run build
```

> **Mac: do not put this folder in `~/Desktop`, `~/Documents` or `~/Downloads`.** macOS protects those
> folders, and apps that launch the server from there can be refused permission to read its own
> files (`EPERM: operation not permitted`). `~/flow-mcp` or anywhere in your home folder is fine.
>
> **Windows: keep it out of folders OneDrive syncs** (often Desktop and Documents), where files can be held
> online-only. `C:\Users\<you>\flow-mcp` is fine.

Then sign in, once:

```bash
npm run login
```

That opens the dedicated Chrome window. Sign into Google by hand, open (or create) a Flow project,
and leave the window open. The program never types your password; it only uses the session you
created. That Chrome profile lives in `~/.flow-mcp/chrome-profile` and is separate from your
everyday browser.

---

## Connect it to Claude, Codex or Antigravity

**Claude Code**

```bash
claude mcp add --scope user flow -- node /absolute/path/to/flow-mcp/dist/index.js
```

`--scope user` makes it available in every folder; the default (`local`) only works in the folder you ran it from.

### Use Dia instead of Chrome (macOS)

Set `FLOW_MCP_CHROME` when logging in and when registering the MCP server:

```bash
FLOW_MCP_CHROME=/Applications/Dia.app/Contents/MacOS/Dia npm run login
claude mcp add --scope user flow -e FLOW_MCP_CHROME=/Applications/Dia.app/Contents/MacOS/Dia -- node /absolute/path/to/flow-mcp/dist/index.js
```

Keep `flow` before `-e`: Claude treats `-e` as accepting one or more environment variables. Flow MCP stores its separate session in `~/.flow-mcp/chrome-profile`, so it does not use your everyday Dia profile.

**Claude Desktop**: add to `claude_desktop_config.json` (Mac: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`). On Windows, write the path with doubled backslashes, like
`"C:\\Users\\you\\flow-mcp\\dist\\index.js"`:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/absolute/path/to/flow-mcp/dist/index.js"] } } }
```

**Codex**: add to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.flow]
command = "node"
args = ["/absolute/path/to/flow-mcp/dist/index.js"]
```

Or run `codex mcp add flow -- node /absolute/path/to/flow-mcp/dist/index.js`. No timeout setting is needed:
Codex, like most MCP apps, gives up on a tool call after 60 seconds, so any call that runs longer than about
45 seconds (creating a character, a 1080p download) answers with a task id instead and keeps working, and
`flow_wait` collects the result.

**Antigravity** (Google's coding app): add a `flow` entry to `mcp_config.json`.
- **macOS / Linux:** `~/.gemini/antigravity/mcp_config.json`
- **Windows:** `%USERPROFILE%\.gemini\antigravity\mcp_config.json`
- Or open it from the agent panel's **…** menu → **Manage MCP Servers** → **View raw config**.

Keep any servers already listed and add this one beside them (use doubled backslashes `\\` on Windows, and optionally set `FLOW_MCP_OUTPUT` to store outputs on any drive):

```json
{
  "mcpServers": {
    "flow": {
      "command": "node",
      "args": ["/absolute/path/to/flow-mcp/dist/index.js"],
      "env": {
        "FLOW_MCP_OUTPUT": "/optional/path/to/output"
      }
    }
  }
}
```

**Other MCP apps** (Cursor, VS Code and others) take the same command and arguments in their own MCP
settings. ChatGPT in the browser or the ChatGPT app can't use it: its connectors only reach servers on
the internet, and this tool has to run on your own computer to drive your Chrome window.

Developed and tested with Claude. Codex and Antigravity speak the same protocol, so they should work the
same way, but neither has been tried yet, so please report how it goes. Running two of them at once is safe:
the first one started drives Flow, and the others pass their requests to it.

Restart the app, then ask it: *"check my Flow session"*. You should get your plan and credit balance
back. Everything after that is plain English; you never type tool names.

---

## Your first film

Nothing below costs a credit until step 4, and the assistant asks before spending.

1. **Check the session.** *"Check my Flow session."* This confirms sign-in, plan and credits.
2. **Make a character.** *"Create a character called Pip, a small lamplighter in a flat cartoon style."*
   Flow draws the portrait. Free.
3. **Draw the key frames.** *"Draw three stills with Pip: a dark rooftop, him lighting a lamp, the
   whole hillside glowing. Match each one to the last."* Free: stills cost nothing, so get the look
   right here before spending.
4. **Shoot it.** *"Turn those into three 10-second shots, each starting where the last one ended,
   720p, no more than 15 credits each."* This spends credits. The price is read from Flow's own
   quote first and the scene is skipped if it is over your cap.
5. **Narrate it.** *"Record this line with a warm documentary voice."* Free, any length.
6. **Cut it.** *"Join the three shots under the narration, don't freeze the last frame."*
   The finished file lands in `~/flow-mcp-out/<project>/`.

---

## The control panel

The same features, without an AI assistant in the loop:

```bash
npm run studio     # then open http://127.0.0.1:8787
```

or double-click **Flow Studio.command** (Mac), **Flow Studio.cmd** (Windows) or **Flow Studio.sh** (Linux).

Eight tabs, in the order you would use them:

- **Cast**: reusable characters. Create them, edit them in place, or build one from a picture.
- **Frames**: free stills, with *match previous frame* to keep a set on-model.
- **Shots**: paid clips, with first/last frames, chaining, a live credit estimate, and a card that
  continues a finished clip from its own last frame.
- **Voice**: free narration with Kokoro (the default: 28 voices, runs on your computer, no key) or Google's
  voices. Your saved narrations are listed
  here to play or delete, and there's a field for your Google AI Studio key (checked with Google, stored
  only on your computer; never paste it into a chat).
- **Restyle**: change a clip you already have.
- **Cut**: join any videos into one film, in the order you pick. Upload one, or choose from films you've
  already made. Add a narration (from your saved ones or an upload) and music, and turn the clips' own
  sound down so the narration sits on top.
- **Captions**: put the spoken words on screen, the way short-form videos do, on wide or vertical videos.
  Pick a video and the language spoken in it (about 100 languages, or Detect automatically), choose a
  style (Bold pop, Highlight, Word by word, Clean, Boxed), where it sits (bottom,
  middle, top, an exact height, or tap the preview), its size (a slider), its letters (normal, CAPS or lowercase) and
  highlight colour, and see it on a real frame of your video before anything is made. Fix any misheard
  word in the text box and it keeps its timing; press Enter to start a new caption. Saves `<name>-captions.mp4` plus an `.srt` for YouTube.
  Everything happens on your computer; nothing is uploaded.
- **Library**: everything in your Flow project. Download it again for free (a scene comes down as one
  finished film, not loose clips), or move it to Flow's Trash.

A progress monitor and a gallery of your saved work sit alongside. The gallery shows stills or clips
on the tabs that use them. On a wide screen, each side scrolls on its own. Two kinds of delete, clearly
labelled: **Move to the Mac's Trash / Recycle Bin** removes a file from your computer; **Move to
Flow's Trash** removes it from your Flow project only. Both can be undone.

The panel ships with the repo but is not started for you: run `npm run studio` when you want it.
Opening `studio/index.html` as a plain file does nothing; the page needs the server behind it, and
says so in red if you try.

Claude's own process serves the same panel while it runs. Whichever process starts first owns the
Chrome tab and the job queue; the other talks to it over a local API, so Claude and the panel always
agree on what is running. That API listens on 127.0.0.1 only and needs a per-run token
(`~/.flow-mcp/token`).

### Background service

If you want the control panel running without keeping a terminal window open, use `flow-studio`
(after `npm run build`; run it via `npm run flow-studio -- <command>` or install the bin with `npm link`):

```bash
npm run flow-studio -- start --open   # start in the background and open the panel
npm run flow-studio -- status         # show URL, process id, Chrome window, and paths (--json supported)
npm run flow-studio -- stop           # stop the background service and close Flow Studio's Chrome window
```

- `stop` refuses to interrupt an active generation unless you pass `--force`, refuses to stop a server
  owned by your AI assistant, and only closes Chrome windows that Flow Studio itself launched
  (pass `--keep-chrome` to leave Chrome open).
- Settings live in `~/.flow-mcp/config.json` (`port`, `cdpPort`, `output`, `chrome`), the running
  owner is recorded in `~/.flow-mcp/studio.json`, and background logs go to `~/.flow-mcp/logs/studio.log`
  (rotated at 5 MB, keeping one backup). Environment variables still override `config.json`.
- If the configured panel or Chrome port is already held by another unrelated program, Flow Studio
  picks the next free port automatically and records it so `status`, `stop`, and MCP clients find it.

### Several accounts at once

With one Google account, everything stays in `~/.flow-mcp/` with no extra setup. If you have more than
one Google account and want Flow MCP to share batches across them in parallel, add extra accounts:

```bash
npm run login -- backup    # opens a separate Chrome window for "backup"; sign in and open a Flow project
```

Or ask your assistant to use `flow_accounts` (`add`, `list`, `enable`, `disable`, `remove`). Each
additional account keeps its own Chrome profile, port, downloads, and memory under
`~/.flow-mcp/accounts/<name>/`, while the default `main` account stays in `~/.flow-mcp/`. Ready,
enabled accounts automatically share unpinned scenes from the queue in parallel (one active job per
account, respecting each account's pacing).

### Parallel image batches

By default `flow_generate` runs one scene at a time. When generating several independent stills
(`kind: "image"` with no `chain_previous` / `first_frame` / `last_frame`), you can pass
`parallel_images: true` on `flow_generate` to submit up to 6 stills per account at a time (10–20 s
apart inside Flow's composer, reading each scene's credit quote before sending) and wait for all of
them together. Each finished image is matched back to its scene by its prompt and attached references
so scene numbers stay right regardless of finish order. Video scenes always stay serial.

### Flow Music

This tool also drives **Google Flow Music** (`https://www.flowmusic.app/`), Google's separate song-making
site (Lyria 3.5 / Lyria 3 Pro), using its compose panel. Flow Music runs in its own Chrome window inside
your account's Chrome profile and on its own queue lane, so songs generate alongside Flow videos and images
without waiting behind them.

Sign in to Flow Music once:

```bash
npm run login -- --music            # main account
npm run login -- backup --music     # additional account
```

- **Tools:** `flow_music_status` (sign-in, plan, credits, music lane), `flow_music` (queue songs from a sound
  description, optional lyrics, instrumental toggle, title, length 1:00–3:00 / `length_seconds` 60–180, BPM,
  seed, model, and formats), `flow_music_songs` (list your library), and `flow_music_download` (download
  existing songs by id or exact title). Songs land in `~/flow-mcp-out/<project>/song-NN.<ext>` in `m4a`
  (default), `mp3`, or `wav`.
- **Credit guard:** Flow Music shows **no price before generating** (observed price: 5 credits per song).
  `max_credits` defaults to 10 and must be at least 5 or the song is refused before anything is typed; your
  credit balance is also checked before generating (refused if under 5). Spend is measured from the balance
  before minus after: if a song costs more than `max_credits`, it finishes with a warning note and every
  remaining queued music job is failed so nothing else starts.
- **Pacing:** songs have their own pause range, defaulting to Flow's (25–70 s) and overridable with
  `FLOW_MCP_MUSIC_PAUSE_MIN_S` and `FLOW_MCP_MUSIC_PAUSE_MAX_S`.
- **Not there yet:** chatting with the Producer, uploading reference audio, remixing, splitting stems, and
  music videos.

---

## Tools

| Tool | Purpose |
|---|---|
| `flow_status` | Session state (signed in, which project is open, plan, credits left), queue, pacing, prompt playbook |
| `flow_accounts` | Manage Google Flow accounts (`list`, `add`, `enable`, `disable`, `remove`) so several signed-in accounts can work in parallel |
| `flow_image_models` | List Flow's available image models and optionally save a default image model (used when `model` is omitted on image generations) |
| `flow_projects` | List the projects on your Flow home page (in a temporary tab so the open project is untouched) and mark which one is open |
| `flow_new_project` | Create a new, empty Flow project and open it, optionally with a title |
| `flow_open_project` | Open one of your existing Flow projects by name, UUID or URL; `flow_projects` and `flow_status` list the names |
| `flow_rename_project` | Rename the currently open Flow project from the project grid and confirm Flow kept the new title |
| `flow_generate` | Queue scenes: prompt, image or video, model, aspect, duration, resolution, variants, first/last frame, reference images, `max_credits` cap, optional `account` pin, and opt-in `parallel_images` for independent stills |
| `flow_wait` | Wait for jobs, or for the task id of a slow call; returns file paths and results. Answers within about 40 s, so call again until `finished` is true |
| `flow_cancel` | Cancel a job that has not started |
| `flow_retry` | Re-queue failed jobs with the same settings and file names (a failed tile is first retried inside Flow with its own free Retry button: `retries`, default 1) |
| `flow_assets` | List images, videos, scenes, characters and collections in the Flow project (usable as `asset:<title>`). `recursive: true` walks every Library collection; `collection: "<path>"` lists one collection with `path` and `ref` for `flow_download` |
| `flow_download` | Download existing project media without regenerating. Free, including the 1080p / 2K upscale. Pass `assets` for individual titles or Library `<collection path>/<title>` refs (a scene comes down stitched; a character comes down as its portrait), or pass `collection` to bring a whole Flow collection down as one ZIP of originals |
| `flow_trash` | Move an image, video or scene in the Flow project to Flow's Trash, where it can be restored. Exact title only; refuses if two items share it; never deletes permanently |
| `flow_rename` | Rename an existing image, video or scene in the Flow project by its exact current title. Refuses ambiguous or already-taken titles |
| `flow_agent_images` | Fast image batch: hands up to 50 scenes to Flow's own Agent mode, rendered in parallel (20 images in ~204 s), 0 credits. The finished images are gathered into a Flow collection and come down as ONE ZIP of originals, checked against the batch and downloaded again if one is missing; if that step fails, the batch stops and says where the images are, and never downloads them one by one. If Agent mode cannot be used at all, the batch stops with the reason. Each image is matched back to its scene by its stored prompt, so file numbers are right in any finish order. Scenes the agent drops are re-asked of it (up to 2 rounds), then re-run one by one. `references` attaches characters, places and objects once in the agent's composer (like its + button), and `scene_references` says which scenes use which, so a whole story stays on-model; scenes made one by one keep their references |
| `flow_cutout` | An image with a **transparent background** (PNG): Flow draws the subject on pure white, redraws the same picture on pure black, and the two are compared pixel by pixel on your computer (difference matting), so glass, hair and soft edges keep real partial transparency. From a `prompt` or an existing `image`; two free images, 0 credits |
| `flow_edit` | Video-to-video edit of a clip already in the project (relight, weather, remove objects). Flow shows no quote first; about 20 credits for a 4 s clip |
| `flow_continue` | Start a clip from the last frame of an existing one **with a character or your avatar still attached**. The composer allows a start frame or attached characters, never both, so this drives Flow's agent mode, which does both. No quote beforehand |
| `flow_character` | Create a reusable character from a description (Flow draws the portrait) or an image, with a personality and a stock voice (or `voice_from` another character for outfit variants); use it as `asset:<name>` |
| `flow_character_edit` | Restyle an existing character in place (free) and save the new portrait, or change its voice (`voice` / `voice_from`; a voice-only call skips the redraw). Pass `look` with the updated description; with only a name it re-saves the current portrait |
| `flow_characters` | List the project's characters with their remembered voices (`with_voices: true` reads each voice live from Flow; `include_library: true` adds characters filed in Library collections with a `ref` for `flow_download`) |
| `flow_techniques` | 39 film-technique prompt presets (camera moves, product shots, transitions, image commands); pass an id as a scene's `technique` |
| `flow_narrate` | Free narration audio, any length: `kokoro` (the default, a voice that runs on your computer, 28 voices and a `speed`), or `gemini` (Google AI Studio text-to-speech, with the same voices Flow has, plus a `style` note; falls back to Kokoro when the daily limit is used up) |
| `flow_voices` | Narrator voices available, whether Kokoro's model is downloaded yet, and whether a Google key is set up |
| `flow_captions` | Burn spoken-word captions into any video, landscape or vertical, in one of five styles, at any height and size, in normal, capital or lowercase letters, in about 100 languages; returns the transcript so a misheard word can be fixed and the call repeated (local whisper.cpp, Chrome and FFmpeg, no credits) |
| `flow_transcribe` | Hear the words in any video or audio on your computer, with each word's start and end time (local whisper.cpp, free) |
| `flow_assemble` | Join clips into one MP4 (a project's clips, or any you list, in order) with optional music and voiceover, and separate volume for the clips' own sound. A voiceover can also be built line by line (`voice_lines`), each line cut from a take and placed at its own moment, for narration timed to on-screen titles (local FFmpeg, no credits) |
| `flow_music_status` | Check Flow Music sign-in, plan tier, credit balance, window URL, and music queue lane |
| `flow_music` | Queue songs via Flow Music's compose panel (Lyria 3.5 / Lyria 3 Pro) on the separate music lane; supports instrumental/lyrics, 1:00–3:00 (`length_seconds` 60–180), BPM, seed, model, `m4a`/`mp3`/`wav` downloads, and credit guard (observed 5 credits/song; default `max_credits` 10) |
| `flow_music_songs` | List songs in your Flow Music library (newest first) with clip id, title, length, creation time, and sound description |
| `flow_music_download` | Download existing songs from your Flow Music library by clip id or exact title in `m4a`, `mp3`, or `wav` (free; refuses ambiguous titles with matching ids listed) |

**Continuity between shots:** `chain_previous` (this clip starts on the last frame of the previous
one), `first_frame` + `last_frame` (animate between two stills you chose), `reference_images` (keep a
character or product consistent). Flow's *composer* takes either frames or references, never both, so
when you need a start frame **and** a character locked together, use `flow_continue`, which goes through
Flow's agent mode and does both.

Output lands in `~/flow-mcp-out/<project>/scene-NN.ext`.

### Narration voices

`flow_narrate` uses **Kokoro** by default: a free voice that runs on your own computer, with no key, no daily
limit and no length cap. Pick any of its 28 English voices (American and British) and a speed. The first take
downloads its model once (326 MB, about a minute); after that a take records in a couple of seconds.

#### Google's voices (optional)

For Google's voices (the same ones Flow offers), get a free key from
[Google AI Studio](https://aistudio.google.com/apikey) and paste it into **Flow Studio → Voice → Google AI Studio
key → Save key**. It's checked with Google before it's saved, and stored only on your computer. Or set
`GEMINI_API_KEY`. Either way, never paste the key into a chat; it would end up in the conversation history.

---

## Behaviour and settings

- One generation at a time, with a random 25–70 second pause between them. The page carries an
  invisible reCAPTCHA; this drives the real interface at human pace and does nothing to evade it.
- Before each generation the server reads Flow's own credit quote and skips the scene if it exceeds
  `max_credits` (default 25).
- Any Google account language works. The server finds Flow's buttons by their English names, so its
  Chrome window always shows Flow in English (it adds `?hl=en` to the address). Your account's own
  language setting is never changed, and prompts can be written in any language.
- Settings file: `~/.flow-mcp/config.json` (`port`, `cdpPort`, `output`, `chrome`), created on first
  `flow-studio start`. Environment variables override it: `GEMINI_API_KEY`, `FLOW_MCP_PORT` (8787),
  `FLOW_MCP_OUTPUT`, `FLOW_MCP_HOME`, `FLOW_MCP_CDP_PORT` (9333), `FLOW_MCP_CHROME`, `FLOW_MCP_PROJECT`,
  `FLOW_MCP_PAUSE_MIN_S`, `FLOW_MCP_PAUSE_MAX_S`, `FLOW_MCP_MUSIC_PAUSE_MIN_S`, `FLOW_MCP_MUSIC_PAUSE_MAX_S`.
  Helper programs, if they are not on your PATH: `FLOW_MCP_FFMPEG`, `FLOW_MCP_FFPROBE`, `FLOW_MCP_WHISPER`.
- Everything can live on another drive. `FLOW_MCP_HOME` moves the Chrome profile, downloads, settings and logs;
  working files for cutting and captions then go to a `tmp` folder inside it (or wherever `FLOW_MCP_TMP` points)
  instead of the system's temp folder. `FLOW_MCP_OUTPUT` moves the finished films.
- Downloads go to a folder only this tool uses. If Chrome ever saves one to your own Downloads folder instead, it is
  taken from there only with proof that it came from Flow; nothing else in that folder is touched.
- `FLOW_MCP_TRACE=1` writes every step of a job, with how long it took, to stderr (`logs/studio.log` for the
  background service). Use it to see where a job is slow or where it stopped.

## If something goes wrong

| Symptom | Cause |
|---|---|
| Mac: the server will not start, `EPERM: operation not permitted` | The folder is in a macOS-protected location. Move it out of `~/Desktop`, `~/Documents` or `~/Downloads` and update the path in your Claude config |
| *"Not signed in"* or *"no project open"* | Run `npm run login`, sign in, open a Flow project, leave the window open |
| A clip generated but no file arrived | The media is still in Flow. `flow_download` pulls it back for nothing. Never re-generate and pay twice |
| Everything times out | The Chrome window was closed, or the machine slept. Reopen it with `npm run login` |
| Linux: `npm install` fails in `onnxruntime-node` with *"Failed to download the binaries: 404"* | Its installer wants GPU files that are no longer published. This repository's `.npmrc` skips them; if your npm ignores that, run `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install` |
| *"Could not attach to Chrome: this is Chrome 156..."* (`Browser context management is not supported`) | Chrome 156 refuses a call Playwright makes when attaching. Update Google Chrome (this does not happen on Chrome 158+) and try again |
| *"Chrome is translating Flow's page..."* | Chrome's auto-translate rewrites button labels so selectors miss, even when the page still looks English. Click the translate icon in the Flow Chrome address bar and choose never to translate this site, or close Flow's Chrome window so it reopens with translation off |
| *"This account shows Flow's agent-only composer..."* | Google is serving a composer variant with no per-generation settings controls to that account; nothing was generated or charged. `flow_agent_images` may still work for stills. Please open an issue at [Pho3niX90/flow-mcp/issues](https://github.com/Pho3niX90/flow-mcp/issues) with your Google AI plan and the date so it can be mapped |
| Every click takes seconds and jobs crawl | Flow's Chrome window was opened by an older version. Chrome slows a window that is covered by other windows to one frame a second, and this version starts Chrome so that it does not. Close Flow's Chrome window; the next job opens it again |
| A job is slow or stops and you cannot tell where | Start it with `FLOW_MCP_TRACE=1` and read the steps and their times in the log |

---

## Updating

Tell your assistant: *"Update Flow MCP: in my flow-mcp folder, run git pull, then npm install, then npm run
build."* Then fully quit and reopen your assistant app so it loads the new version.

---

## Security

- **Flow's Chrome remote-control port:** to drive Flow, this tool starts its dedicated Chrome window with a
  remote-debugging port (`--remote-debugging-port`) listening on `127.0.0.1` (this computer only) with no
  password. While that window is open, any program running on your computer can reach that port and drive
  the signed-in Google session.
- **Control panel API:** Flow Studio's HTTP API also listens on `127.0.0.1` only and requires a per-run token
  saved in `~/.flow-mcp/token`.
- **File and folder boundaries:** downloads go to a dedicated folder under `~/.flow-mcp/`; if Chrome ever
  falls back to your own `~/Downloads` folder, a file is taken only with proof that it came from Flow, so
  unrelated downloads are never touched. Project names like `..` are refused so outputs can never be written
  outside your output folder.
- **Practical advice:** use a dedicated Google account kept for Flow MCP, close Flow's Chrome window when it
  is not in use (`flow-studio stop` closes it for you), keep two-step verification turned on, and install from
  a commit you have reviewed rather than updating blindly.

---

## What this continuation adds

Everything below is on top of upstream as it stood on 21 November 2026.

**Community pull requests, brought in after review.** Each was ported onto current code and committed under its
author's name, with the fixes it needed as separate commits. The numbers are the pull requests on
[GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp/pulls).

| | What it brings | By |
|---|---|---|
| #1 | `flow-studio start`, `stop` and `status`: Flow Studio as a background service | [neurodata-solutions](https://github.com/neurodata-solutions) |
| #2 | FFmpeg is found when it was installed after the server started; Antigravity setup | [HRDevelops](https://github.com/HRDevelops) |
| #6 | Windows narration fix, the Check key button, a clear stop at Flow's image-rights dialog | [amed-12](https://github.com/amed-12) |
| #8 | `flow_projects`, exact character-name matching, character voices | [srijonsbzsifat](https://github.com/srijonsbzsifat) |
| #9 | Cut films are tagged Rec.709, so QuickTime no longer washes them out | [lokeshsapkota](https://github.com/lokeshsapkota) |
| #10 | The open project tab is preferred over Flow's marketing page; Dia on macOS | [Batsirai](https://github.com/Batsirai) |
| #11 | A failed save no longer downloads the file again; the paid 4K upscale is never picked | [ebotha9](https://github.com/ebotha9) |
| #13, #14 | Tiles identified by their media id, never by title or position; `flow_rename`; `flow_open_project` | [catabanciu08](https://github.com/catabanciu08) |
| #15, #17 | `flow_cutout`; several Flow accounts in parallel; a saved default image model | [OussamaToumirt](https://github.com/OussamaToumirt) |
| #16 | `parallel_images`: image scenes sent back to back | [bleshs](https://github.com/bleshs) |
| #21 | The queue stops on Flow's "unusual activity" refusal; model names match across renames | [benjamin-ajah](https://github.com/benjamin-ajah) |
| #23 | Video tiles identified by their signed address; a download fallback for Chrome 156 | [mosesoluwanifise](https://github.com/mosesoluwanifise) |
| #25 | Linux support; reliable tile hover; agent panel handling | [On-Off-Grid](https://github.com/On-Off-Grid) |
| #27 | Library collections: list them, walk nested ones, download what is in them | [KaiDream](https://github.com/KaiDream) |
| #30 | Omni 1.2 model matching whatever the word order, with the first unit tests | [Bl0ck154](https://github.com/Bl0ck154) |
| #32 | A Docker image | [wachiravit-thitagran](https://github.com/wachiravit-thitagran) |
| #38 | Flow's renamed agent switch | [inanctelci](https://github.com/inanctelci) |
| #41 | Renaming from the item's own page, since the grid's Rename stopped saving | [rfpassos](https://github.com/rfpassos) |

Not brought in: #5, #34, #35 and #36 (upstream's own 21 November update does the same), #31 (withdrawn by its
author), #33 (it skipped the clip length on Omni 1.2) and #29 (its credit estimate undercounted 11 to 15 second clips,
which would have let a job spend past its limit).

**Fixes made here.**

- A file you download yourself is never taken from your Downloads folder and renamed as a clip.
- A project called `..` no longer saves outside the films folder.
- Jobs take about a third of the time: Chrome keeps drawing when its window is covered, and attaching a reference
  image no longer waits 30 seconds.
- A failed tile left by an earlier job is not mistaken for a new failure, so Flow's Retry is not pressed on old work.
- On Windows, Chrome opens in a visible window when the server was started hidden, starts correctly from a folder
  with a space in its name, and saves to another drive.
- A Flow Chrome window left open by an older version is found again after updating.
- `flow_trash` and `flow_rename` refuse whole Library collections.
- Working files follow `FLOW_MCP_HOME` to another drive.
- `npm install` works on Linux again (a dependency's GPU download had started failing the whole install).
- **Google Flow Music (`flowmusic.app`):** make songs through the compose panel (`flow_music`), list your
  library (`flow_music_songs`), download in M4A/MP3/WAV (`flow_music_download`), and check status/credits
  (`flow_music_status`), running in its own Chrome window and queue lane alongside Flow.
- Tests: `npm test` runs them, and they run on Windows, macOS and Linux for every change.

**Upstream issues addressed.** Numbers link to [GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp/issues).

- [#3](https://github.com/GTAI-1/flow-mcp/issues/3), [#37](https://github.com/GTAI-1/flow-mcp/issues/37), [#43](https://github.com/GTAI-1/flow-mcp/issues/43): agent switch matched across all UI variants, with no 30-second wait when the toggle is absent.
- [#4](https://github.com/GTAI-1/flow-mcp/issues/4): Flow pinned to English (`?hl=en`); Chrome page translation disabled on launch and detected if already active.
- [#18](https://github.com/GTAI-1/flow-mcp/issues/18), [#24](https://github.com/GTAI-1/flow-mcp/issues/24): docked agent side panel closed automatically; the agent-only composer variant fails fast with a clear message (not yet supported for single generations).
- [#19](https://github.com/GTAI-1/flow-mcp/issues/19): tiles identified by media id instead of title or grid position.
- [#20](https://github.com/GTAI-1/flow-mcp/issues/20): project tools (`flow_projects`, `flow_new_project`, `flow_open_project`, `flow_rename_project`).
- [#22](https://github.com/GTAI-1/flow-mcp/issues/22): clear Chrome 156 error message advising an update to Chrome 158+.
- [#26](https://github.com/GTAI-1/flow-mcp/issues/26): Library collections listed, walked recursively, and downloaded.
- [#28](https://github.com/GTAI-1/flow-mcp/issues/28): all four parts addressed (Downloads folder provenance checks, Security section above, safe project folder names, `LICENSE` and dependency audit fixes).
- [#39](https://github.com/GTAI-1/flow-mcp/issues/39): ISC licence text added in [LICENSE](LICENSE).
- [#40](https://github.com/GTAI-1/flow-mcp/issues/40): too little detail in the report to reproduce directly; the rendering speed and stability fixes here may cover it.
- [#42](https://github.com/GTAI-1/flow-mcp/issues/42): docked agent side panel closed, Flow Studio plan and credit pills survive reloads, and Windows `whisper.cpp` notes added (a Studio language picker is welcome as a pull request).

## Licence and risk

Upstream declares the ISC licence in `package.json` and ships no licence file. This repository keeps that
declaration, includes the ISC text in [LICENSE](LICENSE), and takes contributions under it.

This automates Flow's web interface. It can break whenever Google changes that interface, and
automated use may be against Google's terms of service. Use it on your own account, at your own
risk.
