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
