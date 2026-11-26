import { resolve } from "node:path";

// The folder name a project's files are saved under: anything that is not a letter, digit, "_", "." or "-" becomes "_".
// A name made only of dots is refused. "." and ".." passed through unchanged, so a project called ".." saved into the
// folder above the films folder, and one called "." into the films folder itself.
export function projectFolderName(project: string): string {
  const name = project.replace(/[^\w.-]+/g, "_");
  if (!name || /^\.+$/.test(name)) throw new Error(`"${project}" cannot be used as a project name: use letters or digits.`);
  return name;
}

// Where a project's files are saved: always a folder directly inside `root`.
export const projectDirIn = (root: string, project: string): string => resolve(root, projectFolderName(project));

const PROJECT_GRID_PATH_RE = /^\/project\/[0-9a-f-]{36}$/i;

// Validates a Google Flow project title before typing it into Flow's "Editable text" header box.
export function validateProjectTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new Error("Project title cannot be empty.");
  if (/[\r\n]/.test(title)) throw new Error("Project title must be a single line.");
  if (title.length > 100) throw new Error(`Project title is ${title.length} characters; keep it to 100 characters or fewer.`);
  return title;
}

// True only when a URL points directly to a Flow project grid (`/project/<uuid>`, with any query string such as ?hl=en),
// and false on item/edit/character subpages where a textbox with the same accessible name ("Editable text") renames an item.
export function isProjectGridUrl(url: string): boolean {
  try {
    return PROJECT_GRID_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
