// Pure prompt/reference matching helpers shared between agent batches, parallel image batches, and unit tests.
import { MEDIA_UUID_RE } from "./tiles.js";

const STOP_WORDS = new Set(
  "the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "),
);
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

// Returns, per scene, the indexes of the tiles that belong to it (best match first). A tile counts when at least
// a third of the scene's distinctive words appear in the prompt Flow stored for that tile.
export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  // Words that most scenes share (a long common style paragraph) say nothing about WHICH scene a picture is, and they
  // drowned the distinctive ones: 8 scenes sharing one style text matched 1 of 7 pictures (2026-11-07). Match on what
  // is particular to each scene.
  const all = scenes.map(words);
  const count = new Map<string, number>();
  for (const ws of all) for (const w of ws) count.set(w, (count.get(w) ?? 0) + 1);
  const common = (w: string) => scenes.length > 2 && (count.get(w) ?? 0) >= Math.max(2, Math.ceil(scenes.length * 0.6));
  const sceneWords = all.map((ws) => {
    const own = new Set([...ws].filter((w) => !common(w)));
    return own.size >= 3 ? own : ws;
  });
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter((w) => have.has(w)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  // First give every scene its single best tile, then hand leftover tiles to their best scene as extra takes.
  for (const firstPass of [true, false]) {
    for (const { scene, tile, score } of pairs) {
      // a third of a scene's own words is plenty once the shared boilerplate is gone (the agent paraphrases)
      if (score < 0.3 || usedTiles.has(tile) || (firstPass && out[scene].length)) continue;
      out[scene].push(tile);
      usedTiles.add(tile);
    }
  }
  return out;
}

// Per scene, the indexes of its tiles. Batch prompts are typed word for word (no agent rewording), so a tile's key
// equals its scene's; whatever is left over (a reference whose picture carried no id, say) falls back to the prompt's
// words alone.
export function matchSent(scenes: string[], tiles: string[], takes: number[]): number[][] {
  const out: number[][] = scenes.map(() => []);
  const used = new Set<number>();
  scenes.forEach((key, s) =>
    tiles.forEach((tile, t) => {
      if (tile !== key || used.has(t) || out[s].length >= takes[s]) return;
      out[s].push(t);
      used.add(t);
    }),
  );
  const leftScenes = scenes.map((_, s) => s).filter((s) => !out[s].length);
  const leftTiles = tiles.map((_, t) => t).filter((t) => !used.has(t) && tiles[t]);
  const promptOnly = (key: string) => key.replace(new RegExp(MEDIA_UUID_RE.source, "g"), "");
  matchScenes(
    leftScenes.map((s) => promptOnly(scenes[s])),
    leftTiles.map((t) => promptOnly(tiles[t])),
  ).forEach((picked, n) => out[leftScenes[n]].push(...picked.slice(0, takes[leftScenes[n]]).map((k) => leftTiles[k])));
  return out;
}
