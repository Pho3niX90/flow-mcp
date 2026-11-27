import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assemble, voiceTrack } from "./assemble.js";
import { OUTPUT_ROOT } from "./chrome.js";
import { GEMINI_VOICES, checkGeminiKey, geminiKey, saveGeminiKey, speakWithGemini } from "./gemini.js";
import { KOKORO_DEFAULT_VOICE, KOKORO_MB, KOKORO_VOICES, kokoroReady, speakWithKokoro } from "./kokoro.js";
import { extractFirstFrame, extractFrameAt, extractLastFrame } from "./chain.js";
import { burnCaptions, captionedName, captionSetup, previewCaptions, transcribe } from "./captions.js";
import { presenter, RING_COLOR_RE } from "./presenter.js";
import { characterLook, characterVoice, characterVoices, createCharacter, createProject, downloadAsset, downloadCollection, imageModelFor, LATEST_IMAGE_MODEL, listImageModels, listProjectsSummary, openProject, refOf, renameAsset, renameProject, setCharacterVoice, trashAsset, editCharacter, getFlowState, listAssets, forgetCharacter, listCharacters, rememberCharacter, runAgentBatch, runContinue, runEdit, runGeneration, runImageBatch } from "./flow.js";
import { accountByName, addAccount, defaultAccount, defaultImageModel, enabledAccounts, listAccounts, loadSettings, onAccount, profileDir, saveSettings, setAccountEnabled } from "./accounts.js";
import { getFlowPage } from "./chrome.js";
import { differenceMatte } from "./matte.js";
import {
  MUSIC_DEFAULT_MAX_CREDITS,
  checkMusicCreditsBefore,
  formatMusicLength,
  validateMusicBpm,
  validateMusicFormats,
  validateMusicSeed,
} from "./music-parse.js";
import { MusicOutcomeUnknownError, downloadMusicSongs, generateMusicSong, getMusicState, listMusicSongs } from "./music.js";
import { JobQueue, type Job, type Lane } from "./queue.js";
import { projectDirIn } from "./paths.js";
import { BIN, COMPUTER, moveToBin } from "./platform.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";

export { OUTPUT_ROOT };
const words = (s: string) => s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3).map((w) => w.toLowerCase());

export const projectDir = (project: string) => projectDirIn(OUTPUT_ROOT, project);

const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z
    .string()
    .optional()
    .describe("Model label as shown in Flow, e.g. 'Omni 1.2 Flash' (Flow's default video model since 2026-11-21), 'Veo 3.1 - Lite', 'Nano Banana Pro'. Omni 1.1 Flash, Veo 3.1 - Fast and Veo 3.1 - Quality leave Flow on Dec 5. Images default to the newest Nano Banana (2.1 today); video omitted keeps Flow's current model."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.number().int().min(3).max(15).optional().describe("Video length in seconds. Omni 1.2 Flash: any whole second from 3 to 15. Omni 1.1 Flash: 4, 6, 8 or 10. Veo 3.1 clips are fixed at 8 s."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: the scene is skipped (nothing spent) if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt (each one spends credits). Default 1."),
  first_frame: z
    .string()
    .optional()
    .describe("First frame: absolute image path, 'asset:<title>' for an image already in the Flow project, or the absolute path of a finished clip (.mp4) to start exactly on its last frame - chain_previous across separate calls."),
  first_frame_at: z
    .number()
    .min(0)
    .optional()
    .describe("When first_frame is a clip: start from the frame at this second instead of its last frame, e.g. right where the speech ends, so dead time at the end of a take is skipped. Cut that clip at the same second in flow_assemble's `trims` and the join stays invisible."),
  last_frame: z
    .string()
    .optional()
    .describe("Last frame: absolute image path, 'asset:<title>', or the absolute path of a finished clip (.mp4) to end exactly where that clip begins. With first_frame set to the clip before, this redoes a middle clip and keeps both cuts invisible."),
  reference_images: z
    .array(z.string())
    .max(3)
    .optional()
    .describe(
      "Reference media: absolute image paths, or 'asset:<title>' for media or characters already in the Flow project. Flow's COMPOSER takes references OR first/last frames on a video scene, never both, so with frames set these are skipped and the job says so. Flow itself can do both via agent mode (save the last frame, Animate it, then add the character).",
    ),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches the free 1080p video / 2K image upscale (slower; 4K is never picked). Default original."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow itself reports the generation failed."),
  technique: z.string().optional().describe("Id from flow_techniques (e.g. 'orbit-360'); its exact phrase is appended to the prompt. One per scene."),
  on_screen_text: z
    .boolean()
    .optional()
    .describe("Video only: true when words SHOULD appear in the picture (a sign, a title card). By default every video prompt forbids subtitles and on-screen text, because Omni otherwise burns in its own garbled captions."),
  outfit: z
    .string()
    .max(300)
    .optional()
    .describe("What a referenced character wears in this scene when it differs from their saved look, e.g. 'a plain cream crewneck sweatshirt'. The character lock then keeps face, hair and build but takes the clothes from here."),
  reference_previous: z
    .boolean()
    .optional()
    .describe("Use the previous scene's finished image as an extra reference, so this scene inherits its exact drawing of the characters, style and palette. Best way to keep a set of stills on-model."),
  chain_previous: z
    .boolean()
    .optional()
    .describe("Continue the previous scene in this call: its last frame becomes this scene's first frame. Not valid on the first scene or together with first_frame."),
});

// Raw shapes double as MCP input schemas and, wrapped in z.object, as HTTP body validators.
const captionFields = {
  video: z.string().min(1).describe("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with flow_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z
    .number()
    .min(-0.5)
    .max(0.5)
    .optional()
    .describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Lowercase only: names to keep capitalised even where they start a sentence (e.g. [\"Juno\"]). Names in the middle of a sentence are found by themselves."),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  words: z
    .array(z.object({ text: z.string().min(1), start: z.number().min(0), end: z.number().min(0) }))
    .max(5000)
    .optional()
    .describe("Word timings to use instead of hearing the whole video, e.g. from flow_transcribe on each clip of a joined film, shifted by where each clip starts in it. Use it when the film's own sound (music, a train, crowd) throws the timing off. text still corrects the words on top."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it. auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

// Several Google accounts can be signed in, each in its own Chrome; jobs spread over all of them at once.
const accountField = z
  .string()
  .min(1)
  .optional()
  .describe("Run on this Flow account only (a name from flow_accounts). Default: queued work goes to whichever account is free first; anything that uses media already in a Flow project goes to the first account.");

export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips the plan/credits readout, which briefly opens Flow's account panel.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips, e.g. 'HotelPromo'."),
    scenes: z.array(sceneSchema).min(1).max(100),
    parallel_images: z
      .boolean()
      .default(false)
      .describe(
        "Image scenes only, reference images included: send each scene as soon as the one before it is in, without waiting for it to finish, the way a person does it by hand (10-20 s between sends, up to 6 at a time), then match every image back to its scene. Much faster for several stills. Video scenes and reference_previous scenes still run one at a time.",
      ),
    account: accountField,
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids from a queued call, or the task_id of a call that answered still_working. Default: every queued job."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("An MCP call returns after at most 40 s whatever this says, so call again until finished is true."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job.") },
  assets: {
    kind: z.enum(["image", "video", "scene", "character", "collection"]).optional(),
    recursive: z
      .boolean()
      .default(false)
      .describe("Also walk every Library collection (folders, and folders inside them). Each item then carries its `path` and a `ref` to pass to flow_download."),
    collection: z
      .string()
      .min(1)
      .optional()
      .describe("List one Library collection instead of All media: its path from the top, e.g. 'Places/Place B', or just its name when that is unique."),
    account: accountField,
  },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z
      .array(z.string().min(1))
      .max(30)
      .default([])
      .describe(
        "Individual items to download (titles or title prefixes from flow_assets, in numbering order). For an item inside a Library collection, pass its `ref`, '<collection path>/<title>', e.g. 'Cast/Hero' (resolved against Flow's Library tree).",
      ),
    quality: z.enum(["original", "upscaled"]).default("original"),
    collection: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Download a WHOLE Flow collection as ONE ZIP of originals (each under its own title), e.g. to fetch an agent batch whose download stopped. Omit `collection` and pass `<collection path>/<title>` refs in `assets` to fetch specific items (including upscales or character portraits).",
      ),
    account: accountField,
  },
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    end_hold: z.object({ seconds: z.number().min(0).max(10), fade: z.number().min(0).max(10).optional() }).optional().describe("Hold the last frame this many seconds at the end, fading to black over its last `fade` seconds."),
    music_curve: z.array(z.object({ at: z.number().min(0), volume: z.number().min(0).max(2) })).optional().describe("Music level over the film on top of music_volume: {at: seconds, volume}, straight lines between points. Fade in, drop for a quiet moment, rise for the ending."),
    duck_music: z.boolean().optional().describe("Pull the music down automatically while the voiceover speaks, and let it back up in the gaps."),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    voice_lines: z
      .array(
        z.object({
          file: z.string().min(1).describe("Take to cut the line from: audio or video (its sound is used)."),
          from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from flow_transcribe word times)."),
          to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
          at: z.number().min(0).describe("Where the line starts in the film, seconds."),
          max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
        }),
      )
      .max(60)
      .optional()
      .describe(
        "A timed voiceover built from separate lines, each placed at its own moment in the film - for example lines cut from several Flow takes in your avatar's voice, each landing on the title it describes. Replaces `voiceover`.",
      ),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
    trims: z
      .array(
        z
          .object({
            from: z.number().min(0).optional(),
            to: z.number().min(0).optional(),
            volume: z.number().min(0).max(2).optional().describe("This clip's own sound level, 1 = as made. Lower a take whose background noise is louder than the clip before it, so the room does not jump at the cut."),
            fade_in: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound in (trimmed edges always get 0.015 s so a cut never clicks)."),
            fade_out: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound out."),
            soften_in: z.number().min(0).max(3).optional().describe("For a clip that continues the one before from its last frame: if it starts noticeably sharper than that clip ends (a visible 'skip' at the join), it opens equally soft and sharpens over this many seconds (1 is good). Measured automatically; does nothing when the two already match."),
            saturation: z.number().min(0.5).max(2).optional().describe("Scales this clip's colour (1 = as is). For a clip animated from the last frame of the one before, which can come back paler, so the join shows: measure both sides and match."),
            crop: z
              .object({
                x: z.number().min(0).max(1).optional().describe("Left edge, as a fraction of the width. Default: centred."),
                y: z.number().min(0).max(1).optional().describe("Top edge, as a fraction of the height. Default: centred."),
                w: z.number().min(0.1).max(1).describe("Width kept, as a fraction (0.8 = a 1.25x punch-in)."),
                h: z.number().min(0.1).max(1).optional().describe("Height kept; defaults to w, which keeps the frame's shape."),
              })
              .optional()
              .describe("Punch in on part of this clip, e.g. {x: 0, y: 0, w: 0.78} drops the bottom and right edges to hide something the model put in a corner."),
          })
          .nullable(),
      )
      .optional()
      .describe("One entry per clip, in play order: the seconds of that clip to keep, e.g. [{from: 0.6}, null, {to: 8.4}] cuts a dead start off clip 1 and an awkward pause off the end of clip 3 (null keeps a clip whole). The same clip may be listed twice with two windows to cut a repeated or fluffed line out of its middle. Use flow_transcribe's word times to find the cut points, and never cut inside a stray sound at the start of a take."),
    end_card: z
      .object({
        text: z.string().min(1).max(120).describe("The words, e.g. 'Link in bio' or 'Desk lamp · link below'. A line break starts a new line."),
        seconds: z.number().min(1).max(10).optional().describe("How long it shows. Default 2.5."),
      })
      .optional()
      .describe("A closing card: big centred words over the film's own last frame, blurred and darkened. Free, made on this computer."),
    inserts: z
      .array(
        z.object({
          clip: z.string().min(1).describe("Absolute path of the cutaway clip, e.g. a product close-up."),
          over: z.number().int().min(1).describe("Which clip it covers, counting from 1 in play order."),
          at: z.number().min(0).describe("Where it starts, in seconds into that clip's kept part (after its trim)."),
          seconds: z.number().min(0.2).optional().describe("How long it shows. Default: as long as the cutaway lasts, or to the end of the covered clip."),
          from: z.number().min(0).optional().describe("Start inside the cutaway clip. Default 0."),
          volume: z.number().min(0).max(1).optional().describe("The cutaway's own sound under the covered clip's sound. Default 0.3."),
          crop: z
            .object({ x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), w: z.number().min(0.1).max(1), h: z.number().min(0.1).max(1).optional() })
            .optional()
            .describe("Crop the cutaway like a clip's `trims` crop (fractions), e.g. to take a vertical picture out of a 16:9 export."),
        }),
      )
      .optional()
      .describe("B-roll cutaways: show another clip's picture over part of a clip while that clip's own sound keeps playing - the person keeps talking over the product shot and the picture cuts back to them mid-take, in sync and at the same loudness. Better than voice_lines when the line comes from one of the film's own clips."),
    size: z
      .string()
      .regex(/^\d{2,4}x\d{2,4}$/)
      .optional()
      .describe("Film size as WIDTHxHEIGHT, e.g. '1080x1920' for a phone-ready vertical master. Default: the biggest clip, after any crop."),
    loudness: z
      .number()
      .min(-30)
      .max(-9)
      .optional()
      .describe("Level the finished film's sound to this loudness in LUFS. Flow's takes come out near -24, which is quiet on a phone; social video sits around -14."),
    remove_watermark: z
      .boolean()
      .optional()
      .describe("Paint out the sparkle mark Google's video models put in the bottom-right corner, found automatically and filled from the pixels around it (no crop). The invisible SynthID mark stays, and platforms still expect an AI-content label."),
    watermark_margin: z.number().min(0).max(40).optional().describe("With remove_watermark: grow the mask by this many pixels and make it a diamond. Use about 10 after a long Extend chain, where the mark has been redrawn thicker. Look at the corner afterwards."),
  },
  transcribe: {
    video: z.string().min(1).describe("Absolute path of a video or audio file on this computer."),
    language: z.string().default("auto").describe("Spoken language code (en, es, tr, ja...) or auto. Pass it whenever you know it."),
    words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
  },
  caption_preview: captionFields,
  presenter: {
    project: z.string().min(1).describe("Films folder to save into."),
    presenter: z.string().min(1).describe("Absolute path of the talking recording (an avatar video, say). Its sound plays throughout."),
    segments: z
      .array(
        z.object({
          from: z.number().min(0).describe("Start in the recording, in seconds."),
          to: z.number().min(0).describe("End in the recording, in seconds."),
          layout: z.enum(["full", "corner"]).describe("full: the presenter fills the frame. corner: a circle in the corner over `background`."),
          zoom: z
            .object({ from: z.number().min(1).max(3).optional(), to: z.number().min(1).max(3).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() })
            .optional()
            .describe("Full layout only. A slow move from `from` to `to`, where 1 is the whole frame; x and y are the point to zoom toward, as fractions of the frame (default 0.5, 0.45)."),
          background: z
            .object({
              clip: z.string().min(1),
              from: z.number().min(0).optional(),
              retime: z.array(z.object({ from: z.number().min(0), to: z.number().min(0), speed: z.number().min(0.1).max(8) })).optional().describe("Parts of the clip to play faster or slower, so its action lands on the presenter's words. Times are in the original clip; `from` above is measured after this."),
            })
            .optional()
            .describe("Corner layout only: the clip behind the presenter, and where in it to start."),
          shrink: z.number().min(0.1).max(3).optional().describe("Corner layout only: animate from full frame into the circle over this many seconds at the start of the stretch."),
        }),
      )
      .min(1)
      .describe("The film in order. Each stretch is cut in as listed."),
    corner: z
      .object({
        position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).optional(),
        size: z.number().min(0.15).max(0.7).optional().describe("Circle diameter as a fraction of the frame's height. Default 0.36: readable on a phone."),
        face: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.1).max(1) }).optional().describe("The square of the recording to show in the circle: centre x, centre y, width, as fractions of the recording."),
        margin: z.number().min(0).max(0.2).optional(),
        ring_color: z.string().regex(RING_COLOR_RE).optional(),
      })
      .optional(),
    size: z.string().regex(/^\d{2,4}x\d{2,4}$/).optional().describe("Film size. Default 1920x1080."),
    output_name: z.string().optional(),
  },
  captions: {
    ...captionFields,
    project: z.string().optional().describe("Films folder to save into. Default: the video's own folder when it is already in the films folder, otherwise 'Captions'."),
  },
  caption_setup: {},
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene, in order."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    model: z.string().optional().describe("Image model label as shown in Flow, e.g. 'Nano Banana Pro'. Default: the saved default (flow_image_models), else the newest Nano Banana."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    references: z
      .array(
        z.object({
          image: z.string().min(1).describe("Absolute image path, or 'asset:<title>' for an image or character already in the Flow project."),
          name: z.string().min(1).max(40).describe("Short name the scenes use for it, e.g. 'Ines' or 'the station'."),
        }),
      )
      .max(10)
      .optional()
      .describe(
        "Reference images for the whole batch (characters, places, objects), attached once in the agent's composer like the + button does, so every scene stays on-model. Pair with scene_references to say which scenes use which.",
      ),
    scene_references: z
      .array(z.array(z.string()))
      .optional()
      .describe("One list per scene, in scene order: the reference names that scene uses (empty list for none). Without it the agent decides which references fit each scene."),
    account: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Run the whole batch on this account. Default: with several accounts enabled the batch is split between them and they all render at once; scene numbers stay in order. A batch whose references are 'asset:' items stays whole on the first account, where that media lives.",
      ),
  },
  voices: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z
      .enum(["kokoro", "gemini"])
      .default("kokoro")
      .describe(
        "'kokoro' (the default) is Kokoro, a free voice that runs on this computer: no key, no quota, any length; the first take downloads its model once (326 MB). 'gemini' uses Google AI Studio's text-to-speech - the same voices Flow has, free on the AI Studio tier but with a daily limit, needs a key in ~/.flow-mcp/gemini-key; when that limit is used up the take is recorded with Kokoro instead and the result says so.",
      ),
    text: z.string().min(1).max(3000).describe("The line to speak. About 2.5 words per second: 25 words fit 10 s, 75 words fit 30 s. Record a whole narration in one take."),
    voice: z
      .string()
      .min(1)
      .optional()
      .describe("Voice name from flow_voices for the chosen engine. Defaults: am_michael for Kokoro (try af_heart, af_bella, bf_emma), Charon for Google (Aoede, Gacrux...)."),
    speed: z.number().min(0.5).max(2).optional().describe("Kokoro only: speaking speed, 1 = normal. 0.9 is a calmer narrator pace."),
    style: z.string().max(200).optional().describe("Delivery note for the 'gemini' engine, e.g. 'slowly and warmly'. Keep it to a few words: long notes make the model ramble."),
  },
  cutout: {
    project: z.string().min(1).describe("Folder for the cutout PNG (and the white and black takes it is made from)."),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe("What to draw, e.g. 'a red sneaker, three-quarter view, studio product photo'. Leave the background out: it is set for you. With `image`, an optional note on what to keep."),
    image: z.string().min(1).optional().describe("Cut out a picture you already have instead: absolute path, or 'asset:<title>' of an image in the Flow project."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("1:1"),
    model: z.string().optional().describe("Image model label as shown in Flow. Default: the saved default (flow_image_models), else the newest Nano Banana."),
    download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' makes a 2K cutout (slower)."),
    account: accountField,
  },
  edit: {
    project: z.string().min(1).describe("Local folder for the edited clip."),
    asset: z.string().min(1).describe("Title (or title prefix) of a video already in the Flow project; see flow_assets."),
    prompt: z.string().min(1).describe("What to change, e.g. 'change the time of day to golden hour', 'remove the cup', 'make it snow'."),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Flow shows no quote for edits, so max_credits cannot protect you: a 4 s clip cost 20 credits when measured. The real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    account: accountField,
  },
  continue_shot: {
    project: z.string().min(1).describe("Local folder for the new clip."),
    from_asset: z.string().min(1).describe("Title (or title prefix) of the video to continue from; see flow_assets."),
    prompt: z.string().min(1).describe("What happens in the new clip, written as one continuous shot with one camera move."),
    attach: z
      .array(z.string().min(1))
      .max(3)
      .optional()
      .describe("Characters or avatars to keep attached, by name, e.g. ['Me'] for your own Flow avatar or ['Pip']. This is the whole point of this tool: the normal composer cannot hold a character and a start frame at the same time."),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z
      .enum(["exact", "likeness"])
      .default("exact")
      .describe(
        "'exact' uses Flow's first-frame animation (I2V): the clip begins on the source clip's real last frame, invisible cut, but attached characters are IGNORED - the likeness has to come from the frame itself. 'likeness' uses reference-to-video (R2V): the character stays locked but the opening frame is only approximate. Flow cannot do both; this is a model limit, not a UI one.",
      ),
    acknowledge_cost: z
      .literal(true)
      .describe("Must be true. Agent mode shows no credit quote before it runs, so max_credits cannot protect you; the real cost is reported on the finished job."),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z
      .boolean()
      .optional()
      .describe("Skip the guard that refuses to run when Flow already holds a fresh-looking continuation of this clip. Only pass it when you have checked the grid and genuinely want another paid take."),
    account: accountField,
  },
  trash: { name: z.string().min(1).describe("Exact title of the item to move to Flow's Trash, as listed by flow_assets."), account: accountField },
  rename: {
    name: z.string().min(1).describe("Exact current title of the item, as listed by flow_assets."),
    new_name: z.string().min(1).max(200).describe("The title to give it instead. Refused if something in the project already has it."),
    account: accountField,
  },
  set_key: { key: z.string().min(1).max(200) },
  check_key: {},
  discard: { path: z.string().min(1).describe("A saved film, still, narration or whole project folder inside the films folder, to move to this computer's bin (Mac Trash, Windows Recycle Bin).") },
  outputs: {},
  characters: {
    with_voices: z
      .boolean()
      .default(false)
      .describe("Also read each character's voice live from Flow (about 8 s per character, since each editor has to be opened). Default false returns remembered voices only."),
    include_library: z
      .boolean()
      .default(false)
      .describe("Also list characters filed in Library collections (slower: walks every collection). Those carry a `path` and a `ref` for flow_download."),
    account: accountField,
  },
  accounts: {
    action: z
      .enum(["list", "add", "open", "enable", "disable"])
      .default("list")
      .describe(
        "list: every account with whether it is signed in, has a project open and is busy. add: create a new account and open its own Chrome window on Flow for the user to sign in by hand. open: bring an account's Chrome window up (to sign in or open a project). enable / disable: let an account take work or not (its sign-in is kept).",
      ),
    name: z.string().min(1).max(31).optional().describe("Account name for add/open/enable/disable, e.g. 'work' or 'acc2'. The original account is 'main'."),
  },
  image_models: {
    set_default: z
      .string()
      .min(1)
      .optional()
      .describe("Make this the image model every image job uses when it names none, e.g. 'Nano Banana Pro'. 'latest' goes back to always using the newest Nano Banana. Checked against Flow's own list."),
    account: accountField,
  },
  character_edit: {
    name: z.string().min(1).describe("Character to change, as listed by flow_characters."),
    voice: z
      .string()
      .optional()
      .describe("Give the character this stock Flow voice (e.g. 'Achird'), changing the current one. Voice-only edits skip the portrait redraw."),
    voice_from: z
      .string()
      .optional()
      .describe("Give the character the SAME voice as this other character, e.g. when `name` is a new outfit or copy of it. Read live from Flow if not remembered."),
    change: z
      .string()
      .min(1)
      .max(600)
      .optional()
      .describe(
        "What to change about the look, e.g. 'make his coat red, keep everything else the same'. Leave it out to only save the character's current portrait (after a change made by hand in Flow, or one whose portrait never arrived).",
      ),
    look: z
      .string()
      .min(1)
      .max(1500)
      .optional()
      .describe(
        "The character's whole description AFTER the change, e.g. the old one with 'navy coat' swapped for 'red coat'. Scenes quote it word for word to hold the design, so a stale colour in it fights the new portrait. Without it, the change is added to the end of the old description.",
      ),
    account: accountField,
  },
  projects: { account: accountField },
  new_project: {
    title: z.string().max(80).optional().describe("Name for the new project, e.g. 'Desk lamp UGC ad'. Default: Flow's own date-and-time name."),
    account: accountField,
  },
  open_project: {
    project: z.string().min(1).describe("Project name as Flow shows it, or its uuid/URL. flow_projects and flow_status list the names."),
    account: accountField,
  },
  rename_project: {
    title: z.string().trim().min(1).max(100).describe("New title for the currently open Flow project (1 to 100 characters, single line)."),
    account: accountField,
  },
  character: {
    name: z.string().min(1).max(60).describe("Character name; scenes then reference it as 'asset:<name>' in reference_images."),
    describe: z
      .string()
      .max(1200)
      .optional()
      .describe("What the character looks like. Flow draws the portrait first (free image), then builds the character from it. Use this or `image`."),
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Existing picture instead of `describe`: absolute path, or 'asset:<title>' of an image already in the Flow project."),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional().describe("Frame for the drawn portrait when using `describe`. Default 3:4."),
    look: z
      .string()
      .max(1200)
      .optional()
      .describe("With `image`: the person in the picture in words (face, hair, clothes). Every scene's character lock quotes it word for word, so describe only what the picture shows. Without it, an older description saved under the same name is dropped."),
    personality: z.string().max(500).optional().describe("How the character acts; Flow uses it when crafting scenes."),
    account: z.string().min(1).optional().describe("Account whose Flow project gets the character (characters belong to one project). Default: the first account."),
    voice: z.string().optional().describe("Flow voice name, e.g. 'Charon' (male, informative) or 'Aoede' (female, breezy)."),
    voice_from: z
      .string()
      .optional()
      .describe("For a copy or outfit variation of an existing character: the original's name. Copies that character's voice so continuity holds. Used when `voice` is omitted."),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
  music_status: { account: accountField },
  music: {
    project: z.string().min(1).describe("Folder name under the output root where song-NN.<ext> files are saved."),
    songs: z
      .array(
        z.object({
          sound: z.string().trim().min(1).max(3000).describe("Sound description (style, instruments, mood, tempo feel, production)."),
          lyrics: z.string().max(3000).optional().describe("Lyrics for vocal songs. When omitted or empty, instrumental defaults to true."),
          instrumental: z.boolean().optional().describe("Instrumental track with no vocals. Default: true when lyrics are omitted, false when lyrics are provided."),
          title: z.string().trim().max(100).optional().describe("Optional song title (up to 100 characters)."),
          length_seconds: z.number().int().min(60).max(180).optional().describe("Song length in whole seconds, 60 to 180 (1:00 to 3:00)."),
          bpm: z.number().int().min(20).max(400).optional().describe("Tempo in beats per minute (20 to 400)."),
          seed: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).optional().describe("Numeric seed (digits only)."),
          model: z.string().min(1).optional().describe("Flow Music model label, e.g. 'Lyria 3.5' or 'Lyria 3 Pro'."),
          formats: z.array(z.enum(["m4a", "mp3", "wav"])).min(1).default(["m4a"]).describe("Audio formats to download after generation. Default: ['m4a']."),
          max_credits: z
            .number()
            .int()
            .min(0)
            .default(MUSIC_DEFAULT_MAX_CREDITS)
            .describe("Credit cap per song (default 10). Must be at least 5 (Flow Music's observed price per song) or the job is refused before anything is typed."),
        }),
      )
      .min(1)
      .max(20),
    account: accountField,
  },
  music_songs: {
    limit: z.number().int().min(1).max(200).default(20).describe("Maximum number of songs to list from Flow Music's library (newest first, default 20)."),
    account: accountField,
  },
  music_download: {
    project: z.string().min(1).describe("Folder name under the output root where downloaded songs are saved."),
    songs: z.array(z.string().min(1)).min(1).describe("Song clip ids or exact titles from flow_music_songs. An ambiguous title is refused with its matching ids."),
    formats: z.array(z.enum(["m4a", "mp3", "wav"])).min(1).default(["m4a"]).describe("Audio formats to download (m4a, mp3, wav). Default: ['m4a']."),
    account: accountField,
  },
};

type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;

export const jobView = ({ id, status, params, files, attempts, credits, progress, note, error, failed_scenes, account, outcome_unknown }: Job) => ({
  id,
  status,
  ...(params.lane && params.lane !== "flow" ? { lane: params.lane } : {}),
  ...(account ?? params.account ? { account: account ?? params.account } : {}),
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  credits,
  progress,
  files,
  note,
  error,
  failed_scenes,
  ...(outcome_unknown ? { outcome_unknown } : {}),
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  projects(a: Args<"projects">): Promise<unknown>;
  new_project(a: Args<"new_project">): Promise<unknown>;
  open_project(a: Args<"open_project">): Promise<unknown>;
  rename_project(a: Args<"rename_project">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(a: Args<"characters">): Promise<unknown>;
  accounts(a: Args<"accounts">): Promise<unknown>;
  image_models(a: Args<"image_models">): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  cutout(a: Args<"cutout">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  rename(a: Args<"rename">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  check_key(): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
  transcribe(a: Args<"transcribe">): Promise<unknown>;
  caption_preview(a: Args<"caption_preview">): Promise<unknown>;
  captions(a: Args<"captions">): Promise<unknown>;
  presenter(a: Args<"presenter">): Promise<unknown>;
  caption_setup(): Promise<unknown>;
  music_status(a: Args<"music_status">): Promise<unknown>;
  music(a: Args<"music">): Promise<unknown>;
  music_songs(a: Args<"music_songs">): Promise<unknown>;
  music_download(a: Args<"music_download">): Promise<unknown>;
}

// Flow's own voices: still offered when giving a character a voice, but narration no longer goes through Flow.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

// The highest scene number a queued job will write: an image batch writes one file per scene, not just its first.
const lastNumber = (j: Job) =>
  Math.max(Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0) + (j.params.agent_scenes?.length ?? 1) - 1, ...(j.params.agent_numbers ?? []));

const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

const STILL = /\.(jpe?g|png|webp)$/i;
// The matte reads transparency from how far each pixel moves between the two takes, so the background must be flat
// and the subject must not change at all between them: no shadow, glow or reflection that exists on one take only.
const ON_WHITE =
  "show it alone on a pure solid white background (#FFFFFF), perfectly flat and even: no shadow, no floor, no reflection, no gradient, no vignette, no text, nothing else in the frame. The whole subject in frame with a clear margin on every side.";
const TO_BLACK =
  "Change ONLY the background of this image to pure solid black (#000000), perfectly flat and even. Keep the subject pixel-for-pixel identical: same position, same size, same pose, same crop and framing, same colours, same lighting, every detail and edge unchanged. Do not add any shadow, glow, rim light, reflection or outline.";

export class LocalCore implements Core {
  // True while any generation is running; `/api/shutdown` and `flow-studio stop` refuse without force.
  get busy(): boolean {
    return this.queue.busy;
  }

  // Jobs currently running, reported by `/api/shutdown` when refusing or when forced to interrupt them.
  runningJobs(): { id: string; scene: string; account?: string }[] {
    return this.queue
      .list()
      .filter((j) => j.status === "running")
      .map((j) => ({ id: j.id, scene: j.params.file_stem, ...(j.account ? { account: j.account } : {}) }));
  }

  // One worker per (enabled account, lane), all running at once; each job runs inside its account, so every browser
  // step (getFlowPage, getMusicPage, downloads) goes to that account's own Chrome.
  private queue: JobQueue = new JobQueue((job, account) => onAccount(account, () => this.run(job)), {
    accounts: () => enabledAccounts().map((a) => a.name),
    ready: (account, lane) => {
      if (lane === "music") {
        return onAccount(account, async () => {
          const state = await getMusicState({ readCredits: false });
          return state.signedIn ? undefined : state.hint;
        });
      }
      return onAccount(account, async () => {
        const state = await getFlowState();
        return state.signedIn && state.inProject ? undefined : state.hint;
      });
    },
    batchRunner: (jobs, account) => onAccount(account, () => runImageBatch(jobs)),
  });

  private async run(job: Job): Promise<string[]> {
    if (job.params.lane === "music") return this.runMusic(job);
    const { chain_from, reference_from } = job.params;
    if (reference_from) {
      const still = this.queue.get(reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
      if (!still) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image.`);
      job.params.reference_images = [still, ...(job.params.reference_images ?? [])].slice(0, 3);
    }
    // A clip given as the first frame means "carry on from where it ends", so a clip made in an earlier call can be
    // continued after the user has looked at it.
    const ff = job.params.first_frame;
    if (ff && !ff.startsWith("asset:") && /\.(mp4|webm|mov)$/i.test(ff))
      job.params.first_frame =
        job.params.first_frame_at !== undefined
          ? await extractFrameAt(ff, job.params.first_frame_at, job.params.output_dir)
          : await extractLastFrame(ff, job.params.output_dir);
    // And a clip given as the last frame means "end where it begins": with both, a middle clip can be redone without
    // touching the clips on either side.
    const lf = job.params.last_frame;
    if (lf && !lf.startsWith("asset:") && /\.(mp4|webm|mov)$/i.test(lf)) job.params.last_frame = await extractFirstFrame(lf, job.params.output_dir);
    if (chain_from) {
      const clip = this.queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
      if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
      job.params.first_frame = await extractLastFrame(clip, job.params.output_dir);
    }
    if (job.params.matte_from) return this.runCutout(job, job.params.matte_from);
    if (job.params.continue_from) return runContinue(job);
    if (job.params.agent_scenes) return runAgentBatch(job);
    if (job.params.edit_asset) return runEdit(job);
    return runGeneration(job);
  }

  private async runMusic(job: Job): Promise<string[]> {
    if (!job.params.music) throw new Error("Missing Flow Music parameters for music job.");
    try {
      const res = await generateMusicSong(
        job.params.music,
        job.params.max_credits,
        join(job.params.output_dir, job.params.file_stem),
        (progress) => {
          job.progress = progress;
        },
      );
      if (res.credits_spent !== undefined) job.credits = res.credits_spent;
      const summary = [res.clip.title, res.clip.seconds ? `${res.clip.seconds}s` : "", `id:${res.clip.id}`].filter(Boolean).join(" · ");
      if (res.credits_spent !== undefined && res.credits_spent > job.params.max_credits) {
        job.note = `Warning: song cost ${res.credits_spent} credits, above max_credits=${job.params.max_credits}. Remaining queued music jobs were stopped. (${summary})`;
        this.queue.failQueuedLane("music", "a song cost more than its limit; nothing more was started");
      } else {
        job.note = summary;
      }
      return res.files;
    } catch (err) {
      if (err instanceof MusicOutcomeUnknownError) job.outcome_unknown = true;
      throw err;
    }
  }

  // Calls that drive one account's site window directly (not through the queue) run on the account asked for, or the
  // first one, and wait for nothing: if that account's lane is in the middle of a job they say so instead.
  private direct<T>(account: string | undefined, work: () => Promise<T>, lane: Lane = "flow"): Promise<T> {
    const target = account ? accountByName(account) : defaultAccount();
    if (this.queue.busyOn(target.name, lane)) {
      const msg = lane === "music" ? "A song is generating in the Flow Music window. Wait for it to finish (flow_wait), then retry." : BUSY;
      return Promise.reject(new Error(`${msg} (account "${target.name}")`));
    }
    return onAccount(target, work);
  }

  // Which account a queued job must run on: the one named, or - for work that uses media already in a Flow project
  // (asset:..., an edit, a continuation) - the first account, since that media lives in one account's project.
  // Everything else is left free for whichever account is idle first.
  private pin(account: string | undefined, usesProject: boolean): string | undefined {
    if (account) return accountByName(account).name;
    return usesProject && enabledAccounts().length > 1 ? defaultAccount().name : undefined;
  }

  // Second half of a cutout: redraw the white take on black through Flow, then difference-matte the pair locally.
  private async runCutout(job: Job, whiteJob: string): Promise<string[]> {
    const white = this.queue.get(whiteJob)?.files.find((f) => STILL.test(f));
    if (!white) throw new Error(`The white-background take (job ${whiteJob}) produced no image, so there is nothing to cut out. Run flow_cutout again.`);
    job.params.reference_images = [white];
    const black = (await runGeneration(job)).find((f) => STILL.test(f));
    if (!black) throw new Error("Flow made no black-background take, so the cutout could not be finished.");
    const matte = await differenceMatte(white, black, join(job.params.output_dir, `${job.params.file_stem.replace(/-black$/, "")}.png`));
    job.note = [
      job.note,
      `cutout ${matte.width}x${matte.height}: ${Math.round(matte.opaque_share * 100)}% solid, ${Math.round(matte.clear_share * 100)}% clear`,
      matte.warning,
    ]
      .filter(Boolean)
      .join(" · ");
    return [matte.file, white, black];
  }

  async status({ detailed }: Args<"status">) {
    const enabled = enabledAccounts();
    const accounts = [];
    for (const a of enabled) {
      const flow = await onAccount(a, () => getFlowState(detailed && !this.queue.busyOn(a.name))).catch((err: Error) => ({ error: err.message }));
      accounts.push({ name: a.name, ...this.queue.workerView(a.name), flow });
    }
    // `flow` stays the first account's state so a single-account setup (and the Studio panel) reads it as before.
    return {
      flow: accounts[0]?.flow,
      ...(enabled.length > 1 ? { accounts } : {}),
      image_model: defaultImageModel() ?? "latest (the newest Nano Banana)",
      pacing: this.queue.pausedReason,
      output_root: OUTPUT_ROOT,
      jobs: this.queue.list().map(jobView),
    };
  }

  async generate({ project, scenes, parallel_images, account }: Args<"generate">) {
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);

    const output_dir = projectDir(project);
    // Continue numbering after whatever is already on disk or queued, so reruns never overwrite earlier scenes.
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue
      .list()
      .filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith("scene-"))
      .map(lastNumber);
    const offset = Math.max(0, ...onDisk, ...queued);
    const lookAccount = account ? accountByName(account) : defaultAccount();
    const jobs: Job[] = [];
    await onAccount(lookAccount, async () => {
      for (const [i, { chain_previous, reference_previous, technique, outfit, on_screen_text, ...scene }] of scenes.entries()) {
        const phrase = technique ? techniqueById(technique)!.phrase : "";
        // A referenced character must come out identical, not merely similar, so the scene says so explicitly. The
        // wording stays medium-neutral: the same lock has to serve a flat cartoon character and a photoreal avatar.
        const cast = (scene.reference_images ?? [])
          .filter((r) => r.startsWith("asset:"))
          .map((r) => r.slice(6).trim())
          .filter((n) => characterLook(n) !== undefined || /^[\w .'-]{1,60}$/.test(n));
        // With an outfit the lock still pins face, hair and build, but the clothes come from the scene: otherwise the
        // saved look (Skye's denim shirt) fights a costume the prompt asks for.
        const lock = cast.length
          ? ` CHARACTER LOCK — ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions,${outfit ? "" : " same clothing items in the same colours,"} same hands, and the same rendering style and level of realism as the reference. Never redesign, ${outfit ? "" : "restyle, "}re-proportion, re-age or re-colour them${outfit ? "" : ", and never swap an item for a similar one"}.${cast
              .map((n) => (characterLook(n) ? ` ${n} is exactly: ${characterLook(n)}.` : ""))
              .join("")}${outfit ? ` WARDROBE IN THIS SCENE: ${outfit.trim().replace(/\.$/, "")}. This replaces any clothing in the reference image or the description above, and stays identical for the whole scene.` : ""}`
          : "";
        // Omni burns its own subtitles into talking clips now and then, garbled ("thyel", "voch"), even when the prompt
        // says "no captions" near the end (protein soda clip 1, 15 credits). Every video therefore opens AND closes on it,
        // unless the scene really wants words in the picture. Captions are added afterwards by flow_captions.
        const noText = scene.type !== "image" && !on_screen_text;
        const textFirst = noText ? "NO SUBTITLES, NO CAPTIONS, NO TEXT OF ANY KIND ON SCREEN. " : "";
        const textLast = noText
          ? " NO TEXT ON SCREEN: never add subtitles, captions, titles, speech transcripts, words or letters anywhere in the picture, at any moment; any speech is heard only, never written."
          : "";
        const inherit = reference_previous
          ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
          : "";
        jobs.push(
          this.queue.add({
            ...scene,
            prompt: `${textFirst}${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}${textLast}`,
            chain_from: chain_previous ? jobs[i - 1].id : undefined,
            reference_from: reference_previous ? jobs[i - 1].id : undefined,
            // A reference_previous scene needs the previous image finished, so it waits its turn like a video.
            parallel: parallel_images && scene.type === "image" && !reference_previous ? true : undefined,
            account: this.pin(account, [scene.first_frame, scene.last_frame, ...(scene.reference_images ?? [])].some((r) => r?.startsWith("asset:"))),
            output_dir,
            file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
          }),
        );
      }
    });
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const explicit = Boolean(job_ids?.length);
    const ids = job_ids ?? this.queue.list().filter((j) => j.status === "failed" || j.failed_scenes?.length).map((j) => j.id);
    const jobs: Job[] = [];
    const skippedUnknown: Job[] = [];
    for (const id of ids) {
      const job = this.queue.get(id);
      const p = job?.params;
      if (job?.outcome_unknown) {
        if (explicit) {
          throw new Error(
            `Job ${job.id} (${job.params.file_stem}) is not retried: Generate had already been pressed for it, so retrying would make the song, and pay for it, a second time. Check flow_music_songs and fetch it with flow_music_download instead. What happened: ${job.error ?? "unknown"}`,
          );
        }
        skippedUnknown.push(job);
        continue;
      }
      if (job?.failed_scenes?.length && p?.agent_scenes && job.status === "done") {
        // A batch that finished with some images still failed: make just those again, under their own scene numbers,
        // instead of re-running the whole batch. The list moves to the new job, so it is never retried twice.
        const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
        const numbers = p.agent_numbers ?? p.agent_scenes.map((_, i) => base + i);
        const pick = job.failed_scenes.map((n) => numbers.indexOf(n)).filter((i) => i >= 0);
        job.failed_scenes = undefined;
        jobs.push(
          this.queue.add({
            ...p,
            prompt: `Agent batch: ${pick.length} failed image(s) again`,
            agent_scenes: pick.map((i) => p.agent_scenes![i]),
            agent_numbers: pick.map((i) => numbers[i]),
            agent_scene_refs: p.agent_scene_refs ? pick.map((i) => p.agent_scene_refs![i]) : undefined,
            file_stem: `scene-${String(numbers[pick[0]]).padStart(2, "0")}`,
          }),
        );
        continue;
      }
      const again = this.queue.retry(id);
      if (again) jobs.push(again);
    }
    if (!jobs.length) {
      if (skippedUnknown.length) {
        throw new Error(
          `Skipped ${skippedUnknown.map((j) => `${j.id} (${j.params.file_stem})`).join(", ")} because Generate was already pressed and the outcome is unknown. Check flow_music_songs and use flow_music_download instead of retrying.`,
        );
      }
      throw new Error("Nothing to retry: no failed jobs, and no batch with failed images.");
    }
    return {
      jobs: jobs.map(jobView),
      ...(skippedUnknown.length
        ? {
            skipped_unknown_outcome: skippedUnknown.map((j) => j.id),
            note: "Some timed-out song job(s) were not retried because Generate was already pressed; check flow_music_songs first.",
          }
        : {}),
    };
  }

  async assets({ kind, recursive, collection, account }: Args<"assets">) {
    return this.direct(account, async () => {
      const library = recursive || Boolean(collection);
      return (await listAssets({ recursive, collection }))
        .filter((a) => !kind || a.kind === kind)
        .map((a) => (library ? { name: a.name, kind: a.kind, ...(a.path ? { path: a.path } : {}), ref: refOf(a) } : { name: a.name, kind: a.kind }));
    });
  }

  async download({ project, assets, quality, collection, account }: Args<"download">) {
    return this.direct(account, () => this.downloadNow(project, assets, quality, collection));
  }

  private async downloadNow(project: string, assets: string[], quality: "original" | "upscaled", collection?: string) {
    if (!assets.length && !collection) throw new Error("Name the assets to download, or a collection.");
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = collection ? await downloadCollection(collection, dir) : [];
    // Numbering from 1 every call overwrote clips fetched earlier - it destroyed a finished shot once. Carry on from
    // the highest clip-NN already on disk instead.
    let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
    for (const name of assets) {
      try {
        files.push(...(await downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async assemble({ project, voice_lines, ...rest }: Args<"assemble">) {
    const dir = projectDir(project);
    if (!voice_lines?.length) return assemble({ dir, ...rest });
    mkdirSync(dir, { recursive: true });
    const track = await voiceTrack(voice_lines, join(dir, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
    const film = await assemble({ dir, ...rest, voiceover: track.file });
    return { ...film, voice: track };
  }

  transcribe = transcribeHere;
  caption_preview = captionPreviewHere;
  captions = captionsHere;
  presenter = presenterHere;
  caption_setup = captionSetupHere;

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    if (!existsSync(OUTPUT_ROOT)) return { root: OUTPUT_ROOT, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(OUTPUT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(OUTPUT_ROOT, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root: OUTPUT_ROOT, projects };
  }

  private nextStem(output_dir: string, prefix: string): string {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
    const queued = this.queue.list().filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix)).map(lastNumber);
    return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
  }

  async agent({ project, scenes, aspect_ratio, model, download_quality, references, scene_references, account }: Args<"agent">) {
    const output_dir = projectDir(project);
    if (scene_references && scene_references.length !== scenes.length) {
      throw new Error(`scene_references has ${scene_references.length} entries for ${scenes.length} scenes; give one list per scene (empty for none).`);
    }
    const known = new Set((references ?? []).map((r) => r.name.toLowerCase()));
    const unknown = [...new Set((scene_references ?? []).flat().filter((n) => !known.has(n.toLowerCase())))];
    if (unknown.length) throw new Error(`scene_references names ${unknown.map((n) => `"${n}"`).join(", ")}, which is not in references.`);
    for (const r of references ?? []) {
      if (!r.image.startsWith("asset:") && !existsSync(r.image)) throw new Error(`Reference image not found: ${r.image}`);
    }
    // A reference already in a Flow project (asset:...) exists only in that account's project, so such a batch stays
    // whole on one account. References given as files are uploaded by whichever account runs each part.
    const pinned = this.pin(account, (references ?? []).some((r) => r.image.startsWith("asset:")));
    const first = Number(this.nextStem(output_dir, "scene").match(/\d+/)![0]);
    // With several accounts the batch is cut into one part per account (at least two scenes each) and every account's
    // agent renders its part at the same time. Each part keeps its scenes' own numbers, so the files come out in order.
    const parts = pinned ? 1 : Math.max(1, Math.min(enabledAccounts().length, Math.floor(scenes.length / 2)));
    const size = Math.ceil(scenes.length / parts);
    const jobs: Job[] = [];
    for (let start = 0; start < scenes.length; start += size) {
      const part = scenes.slice(start, start + size);
      const numbers = part.map((_, i) => first + start + i);
      jobs.push(
        this.queue.add({
          agent_refs: references?.length ? references : undefined,
          agent_scene_refs: references?.length && scene_references ? scene_references.slice(start, start + size) : undefined,
          prompt: parts > 1 ? `Agent batch: scenes ${numbers[0]}-${numbers.at(-1)} of ${first}-${first + scenes.length - 1}` : `Agent batch: ${scenes.length} images`,
          type: "image",
          model,
          max_credits: 0,
          aspect_ratio,
          download_quality,
          agent_scenes: part,
          agent_numbers: parts > 1 ? numbers : undefined,
          account: pinned,
          output_dir,
          file_stem: `scene-${String(numbers[0]).padStart(2, "0")}`,
        }),
      );
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  // Two free Nano Banana stills - the subject on white, then the same picture redrawn on black - and a local
  // difference matte turns the pair into a PNG with real transparency, soft edges included.
  async cutout({ project, prompt, image, aspect_ratio, model, download_quality, account }: Args<"cutout">) {
    if (!prompt && !image) throw new Error("Pass `prompt` (Flow draws the subject) or `image` (cut out a picture you already have).");
    if (image && !image.startsWith("asset:") && !existsSync(image)) throw new Error(`Image not found: ${image}`);
    const output_dir = projectDir(project);
    const stem = this.nextStem(output_dir, "cutout");
    const shared = { type: "image" as const, max_credits: 0, aspect_ratio, model, download_quality, output_dir, account: this.pin(account, Boolean(image?.startsWith("asset:"))) };
    const white = this.queue.add({
      ...shared,
      prompt: image
        ? `${prompt ? `${prompt.trim().replace(/\.?$/, ".")} ` : ""}Keep the main subject of the reference image exactly as it is - same shape, colours, details and pose - and ${ON_WHITE}`
        : `${prompt!.trim().replace(/\.?$/, ".")} Draw the subject and ${ON_WHITE}`,
      reference_images: image ? [image] : undefined,
      file_stem: `${stem}-white`,
    });
    const black = this.queue.add({ ...shared, prompt: TO_BLACK, matte_from: white.id, file_stem: `${stem}-black` });
    return { output_dir, cutout: join(output_dir, `${stem}.png`), jobs: [white, black].map(jobView) };
  }

  async edit({ project, asset, prompt, download_quality, account }: Args<"edit">) {
    const output_dir = projectDir(project);
    const job = this.queue.add({ prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, account: this.pin(account, true), output_dir, file_stem: this.nextStem(output_dir, "edit") });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Flow's composer takes a start frame OR a character, never both; agent mode takes both, so this goes that way.
  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force, account }: Args<"continue_shot">) {
    // A lost queue entry is not proof that nothing ran: when the owner process is replaced mid-job the job vanishes
    // while Flow carries on and charges for it. Re-running then spends twice, which is exactly what happened on
    // 2026-09-20. Flow's own grid is the only honest record, so ask it before starting another paid generation.
    if (!force) {
      const recent = (await onAccount(account ?? defaultAccount(), () => listAssets())).slice(0, 6).filter((a) => a.kind === "video");
      const source = from_asset.toLowerCase();
      const echo = recent.find((a) => {
        const n = a.name.toLowerCase();
        return n !== source && !n.startsWith(source) && words(n).some((w) => words(source).includes(w));
      });
      if (echo) {
        throw new Error(
          `Flow already holds a recent clip called "${echo.name}", which looks like a continuation of "${from_asset}" that may have just been generated and charged for. ` +
            `Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`,
        );
      }
    }
    const output_dir = projectDir(project);
    const job = this.queue.add({
      prompt,
      type: "video",
      max_credits: 0,
      continue_from: from_asset,
      attach,
      continue_mode: mode,
      aspect_ratio,
      download_quality,
      account: this.pin(account, true),
      output_dir,
      file_stem: this.nextStem(output_dir, "shot"),
    });
    return { output_dir, jobs: [jobView(job)] };
  }

  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(OUTPUT_ROOT, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async trash({ name, account }: Args<"trash">) {
    return this.direct(account, () => trashAsset(name));
  }

  async rename({ name, new_name, account }: Args<"rename">) {
    return this.direct(account, () => renameAsset(name, new_name));
  }

  async projects({ account }: Args<"projects">) {
    return this.direct(account, () => listProjectsSummary());
  }

  async new_project({ title, account }: Args<"new_project">) {
    return this.direct(account, async () => {
      const made = await createProject(title);
      return { ...made, note: "The Flow window now has this empty project open; every generation goes into it. Characters belong to a project, so make them again here." };
    });
  }

  async open_project({ project, account }: Args<"open_project">) {
    return this.direct(account, () => openProject(project));
  }

  async rename_project({ title, account }: Args<"rename_project">) {
    return this.direct(account, () => renameProject(title));
  }

  private nextSongOffset(output_dir: string): number {
    const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^song-(\d+)/)?.[1] ?? 0)) : [];
    const queued = this.queue
      .list()
      .filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith("song-"))
      .map(lastNumber);
    return Math.max(0, ...onDisk, ...queued);
  }

  async music_status({ account }: Args<"music_status">) {
    const target = account ? accountByName(account) : defaultAccount();
    const busy = this.queue.busyOn(target.name, "music");
    const music = await onAccount(target, () => getMusicState({ readCredits: !busy })).catch((err: Error) => ({ error: err.message }));
    return {
      account: target.name,
      music,
      lane: this.queue.workerView(target.name, "music"),
      pacing: this.queue.pausedReason,
      jobs: this.queue
        .list()
        .filter((j) => j.params.lane === "music")
        .map(jobView),
    };
  }

  async music({ project, songs, account }: Args<"music">) {
    for (const [i, s] of songs.entries()) {
      try {
        checkMusicCreditsBefore(s.max_credits);
        if (s.length_seconds !== undefined) formatMusicLength(s.length_seconds);
        if (s.bpm !== undefined) validateMusicBpm(s.bpm);
        if (s.seed !== undefined) validateMusicSeed(s.seed);
        validateMusicFormats(s.formats);
      } catch (err) {
        throw new Error(`Song ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const output_dir = projectDir(project);
    const offset = this.nextSongOffset(output_dir);
    const pinned = this.pin(account, false);
    const jobs: Job[] = [];
    for (const [i, s] of songs.entries()) {
      const lyrics = s.lyrics?.trim() || undefined;
      const instrumental = s.instrumental ?? !lyrics;
      const formats = validateMusicFormats(s.formats);
      const seed = s.seed !== undefined ? validateMusicSeed(s.seed) : undefined;
      jobs.push(
        this.queue.add({
          prompt: s.title ? `${s.title}: ${s.sound}` : s.sound,
          type: "audio",
          lane: "music",
          max_credits: s.max_credits,
          music: {
            sound: s.sound,
            ...(lyrics ? { lyrics } : {}),
            instrumental,
            ...(s.title ? { title: s.title } : {}),
            ...(s.length_seconds !== undefined ? { length_seconds: s.length_seconds } : {}),
            ...(s.bpm !== undefined ? { bpm: s.bpm } : {}),
            ...(seed !== undefined ? { seed } : {}),
            ...(s.model ? { model: s.model } : {}),
            formats,
          },
          account: pinned,
          output_dir,
          file_stem: `song-${String(offset + i + 1).padStart(2, "0")}`,
        }),
      );
    }
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async music_songs({ limit, account }: Args<"music_songs">) {
    return this.direct(
      account,
      async () => {
        const clips = await listMusicSongs(limit);
        return {
          songs: clips.map((c) => ({
            id: c.id,
            title: c.title,
            ...(c.seconds !== undefined ? { seconds: c.seconds } : {}),
            ...(c.created_at ? { created: c.created_at } : {}),
            ...(c.sound ? { sound: c.sound.length > 160 ? `${c.sound.slice(0, 159)}…` : c.sound } : {}),
          })),
        };
      },
      "music",
    );
  }

  async music_download({ project, songs, formats, account }: Args<"music_download">) {
    return this.direct(
      account,
      async () => {
        const dir = projectDir(project);
        mkdirSync(dir, { recursive: true });
        const offset = this.nextSongOffset(dir);
        const res = await downloadMusicSongs(
          songs,
          (i) => join(dir, `song-${String(offset + i + 1).padStart(2, "0")}`),
          formats,
        );
        return {
          dir,
          files: res.files,
          songs: res.clips.map((c) => ({ id: c.id, title: c.title })),
        };
      },
      "music",
    );
  }

  // A copy of a character must sound like the original. The remembered voice is used when there is one, otherwise it is
  // read live from Flow; a source with no voice is an error, because there is nothing to copy.
  private async resolveVoice(voice?: string, from?: string): Promise<string | undefined> {
    if (voice || !from) return voice;
    const known = characterVoice(from) ?? (await characterVoices([from]))[from];
    if (!known) throw new Error(`"${from}" has no voice, so there is nothing to copy. Pass an explicit voice instead, or give "${from}" one first.`);
    return known;
  }

  async character(a: Args<"character">) {
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
    return this.direct(a.account, async () => {
      const voice = await this.resolveVoice(a.voice, a.voice_from);
      const made = await createCharacter({ ...a, voice });
      // Every scene quotes the saved description in its character lock, so a character made from a picture must not
      // inherit an older description saved under the same name: it described someone else (a "Maya" with a ponytail and
      // a mustard sweater, when the new picture showed loose hair and a grey tee).
      if (a.describe) rememberCharacter(a.name, a.describe);
      else if (a.look) rememberCharacter(a.name, a.look);
      else forgetCharacter(a.name);
      return {
        ...made,
        use_as: `asset:${a.name}`,
        ...(made.voice ? {} : { note: "This character has NO voice. Give it one with flow_character_edit (voice or voice_from) so its voice stays the same across clips." }),
      };
    });
  }

  async character_edit({ name, change, look, voice, voice_from, account }: Args<"character_edit">) {
    return this.direct(account, async () => {
      const wantVoice = await this.resolveVoice(voice, voice_from);
      // A voice-only edit must not redraw or re-save the portrait.
      const out = change || look || !wantVoice ? await editCharacter(name, change) : { name };
      // Every scene that references the character quotes this description in its character lock, so it has to describe
      // the NEW look - "deep navy coat" left in it would argue with a portrait whose coat is now red.
      if (look) rememberCharacter(name, look);
      else if (change) rememberCharacter(name, `${characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
      const set = wantVoice ? await setCharacterVoice(name, wantVoice) : undefined;
      return { ...out, ...(set ? { voice: set.voice, previous_voice: set.previous ?? null } : {}), use_as: `asset:${name}` };
    });
  }

  async characters({ with_voices, include_library, account }: Args<"characters">) {
    return this.direct(account, async () => {
      const names = await listCharacters();
      const voices = with_voices ? await characterVoices(names) : {};
      const own = names.map((name) => ({ name, use_as: `asset:${name}`, voice: with_voices ? (voices[name] ?? null) : (characterVoice(name) ?? null) }));
      if (!include_library) return own;
      // Characters filed in Library collections. Whether Flow's picker offers them to `asset:<name>` is not mapped yet,
      // so they come with the ref flow_download takes, not a use_as.
      const filed = (await listAssets({ recursive: true })).filter((a) => a.kind === "character");
      return [...own, ...filed.map((a) => ({ name: a.name, path: a.path, ref: refOf(a) }))];
    });
  }

  // Accounts: each is its own Chrome profile the user signs in to by hand. Adding one only opens that window on Flow.
  async accounts({ action, name }: Args<"accounts">) {
    const needName = () => {
      if (!name) throw new Error(`Pass \`name\` with action "${action}".`);
      return name;
    };
    if (action === "add") {
      const a = addAccount(needName());
      await getFlowPage(a).then((p) => p.bringToFront());
      this.queue.kick();
      return {
        added: a.name,
        profile: profileDir(a),
        next: `A new Chrome window is open on Flow for "${a.name}". Sign in to that Google account there by hand, then open or create a project. Until then the other accounts take all the work.`,
        accounts: await this.accountList(),
      };
    }
    if (action === "open") {
      const a = accountByName(needName());
      await getFlowPage(a).then((p) => p.bringToFront());
      return { opened: a.name, accounts: await this.accountList() };
    }
    if (action === "enable" || action === "disable") {
      setAccountEnabled(needName(), action === "enable");
      this.queue.kick();
    }
    return { accounts: await this.accountList() };
  }

  private async accountList() {
    const out = [];
    for (const a of listAccounts()) {
      const flow = a.enabled ? await onAccount(a, () => getFlowState()).catch((err: Error) => ({ error: err.message })) : undefined;
      out.push({ name: a.name, enabled: a.enabled, ...(a.enabled ? this.queue.workerView(a.name) : {}), ...(flow ? { flow } : {}) });
    }
    return out;
  }

  // The image models Flow offers (read live from its menu) and the one image jobs use when they name none.
  async image_models({ set_default, account }: Args<"image_models">) {
    const available = await this.direct(account, () => listImageModels());
    if (set_default) {
      const wanted = set_default.trim();
      if (/^(latest|newest)$/i.test(wanted)) saveSettings({ ...loadSettings(), default_image_model: undefined });
      else {
        const match = available.find((m) => m.toLowerCase() === wanted.toLowerCase()) ?? available.find((m) => m.toLowerCase().includes(wanted.toLowerCase()));
        if (!match) throw new Error(`Flow has no image model called "${wanted}". Available: ${available.join(", ")}.`);
        saveSettings({ ...loadSettings(), default_image_model: match });
      }
    }
    const saved = defaultImageModel();
    return {
      default_image_model: saved ?? LATEST_IMAGE_MODEL,
      used_when_none_named: imageModelFor() === LATEST_IMAGE_MODEL ? "the newest Nano Banana in Flow's menu" : saved,
      available,
    };
  }

  // Panel only: deliberately NOT registered as an MCP tool, so a key typed into Flow Studio never reaches Claude.
  async set_key({ key }: Args<"set_key">) {
    return saveGeminiKey(key);
  }

  // Panel only, like set_key.
  async check_key() {
    return checkGeminiKey();
  }

  voices = voicesHere;
  narrate = narrateHere;

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }
}

// Narration never touches Chrome, so it runs in whichever process gets the call. A client then never depends on the
// owner's code: Claude Desktop's own flow-mcp process can be a release behind until the user restarts the app.
export async function voicesHere() {
  // The panel words itself from these, so a PC never reads "this Mac".
  const place = { computer: COMPUTER, bin: BIN, platform: process.platform };
  return { kokoro: KOKORO_VOICES, kokoro_ready: kokoroReady(), kokoro_mb: KOKORO_MB, gemini: GEMINI_VOICES, gemini_ready: Boolean(geminiKey()), place };
}

export async function narrateHere({ project, text, voice, engine, speed, style }: Args<"narrate">) {
  const output_dir = projectDir(project);
  mkdirSync(output_dir, { recursive: true });
  const taken = readdirSync(output_dir).map((f) => Number(f.match(/^narration-(\d+)/)?.[1] ?? 0));
  const target = join(output_dir, `narration-${String(Math.max(0, ...taken) + 1).padStart(2, "0")}.m4a`);
  const line = text.trim();
  if (engine === "kokoro") {
    const v = voice ?? KOKORO_DEFAULT_VOICE;
    return { output_dir, credits: 0, engine, voice: v, ...(await speakWithKokoro(line, v, target, speed)) };
  }
  const v = voice ?? "Charon";
  try {
    return { output_dir, credits: 0, engine, voice: v, ...(await speakWithGemini(line, v, target, style)) };
  } catch (err) {
    // The free AI Studio tier has a daily limit. Running out of it should not stop the film: Kokoro records the line
    // now, and the note says how to get the Google voice back once the limit resets.
    if (!/\b429\b|quota|RESOURCE_EXHAUSTED|rate limit/i.test(String((err as Error).message))) throw err;
    const spoken = await speakWithKokoro(line, KOKORO_DEFAULT_VOICE, target);
    return {
      output_dir, credits: 0, engine: "kokoro", voice: KOKORO_DEFAULT_VOICE, fell_back_from: "gemini", ...spoken,
      note: `Google AI Studio's daily limit is used up, so this take was recorded with Kokoro (${KOKORO_DEFAULT_VOICE}) instead. Record it again with ${v} once the limit resets.`,
    };
  }
}

// Captions never touch Flow or its queue: whisper.cpp hears the words, a headless Chrome of its own draws them. So,
// like narration, they run in whichever process gets the call and never wait for the owner to be restarted.
export async function transcribeHere({ video, language, words }: Args<"transcribe">) {
  const t = await transcribe(video, language);
  return {
    text: t.text,
    word_count: t.words.length,
    language: t.language,
    model: t.model,
    ...(words ? { words: t.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
  };
}

export async function presenterHere({ project, ...a }: Args<"presenter">) {
  return presenter({ ...a, dir: projectDir(project) });
}

export async function captionPreviewHere(a: Args<"caption_preview">) {
  return previewCaptions(a.video, a);
}

export async function captionsHere({ project, ...a }: Args<"captions">) {
  // Save next to the video when it is already one of the user's films, otherwise in a Captions folder.
  const rel = relative(OUTPUT_ROOT, dirname(a.video));
  const inFilms = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const dir = project ? projectDir(project) : inFilms ? dirname(a.video) : projectDir("Captions");
  mkdirSync(dir, { recursive: true });
  return burnCaptions(a.video, a, captionedName(dir, a.video));
}

export async function captionSetupHere() {
  return captionSetup();
}
