// Sites this tool can drive inside an account's Chrome browser. Each site has its own host matcher and start URL,
// and lives in its own Chrome window so both keep drawing at full speed (a background tab is throttled by Chrome).
export type Site = "flow" | "music";

export interface SiteConfig {
  id: Site;
  url: string;
  hosts: RegExp;
}

export const SITES: Record<Site, SiteConfig> = {
  flow: {
    id: "flow",
    url: "https://flow.google.com/",
    hosts: /^https:\/\/(flow\.google\.com(?:[/?#]|$)|labs\.google\/fx(?:[/?#]|$))/i,
  },
  music: {
    id: "music",
    url: "https://www.flowmusic.app/",
    hosts: /^https:\/\/(?:www\.)?flowmusic\.app(?:[/?#]|$)/i,
  },
};

export const FLOW_URL = SITES.flow.url;
export const MUSIC_URL = SITES.music.url;

export function isSiteUrl(site: Site, url: string): boolean {
  return SITES[site].hosts.test(url);
}

// Pure page selector over a list of open page URLs. Returns the index of the page that best serves `site`, or -1.
// For Flow: prefers an open project tab, then a non-/about dashboard page, then any Flow page (optionally restricted
// to `wantedProject` for the FLOW_MCP_PROJECT test hook). Never matches Flow Music pages, and vice versa.
export function pickSiteUrlIndex(site: Site, urls: readonly string[], opts: { wantedProject?: string } = {}): number {
  if (site === "flow") {
    const wantedProject = opts.wantedProject ?? "";
    const matching: number[] = [];
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      if (isSiteUrl("flow", u) && (!wantedProject || u.includes(wantedProject))) matching.push(i);
    }
    if (!matching.length) return -1;
    const project = matching.find((i) => /\/project\//.test(urls[i]));
    if (project !== undefined) return project;
    const nonAbout = matching.find((i) => !/\/about(?:[/?#]|$)/.test(urls[i]));
    if (nonAbout !== undefined) return nonAbout;
    return matching[0];
  }
  return urls.findIndex((u) => isSiteUrl(site, u));
}
