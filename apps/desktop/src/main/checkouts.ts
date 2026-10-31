import type { GitClient } from "@heron/git";

// Heron works in its own clone of each repo; the user's checkout is only used when they
// switch on local checkout mode, and must then be a clone of that repo.

/** Does a remote URL point at github.com/<owner>/<name> (HTTPS or SSH, with or without .git)? */
export function remoteIsRepo(url: string, owner: string, name: string): boolean {
  const tail = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  const want = `${owner}/${name}`.toLowerCase();
  return /github/i.test(url) && (tail.endsWith(`/${want}`) || tail.endsWith(`:${want}`));
}

/** Is `dir` a clone of owner/name? */
export async function isCheckoutOf(git: GitClient, dir: string, owner: string, name: string): Promise<boolean> {
  try {
    return (await git.remoteUrls(dir)).some((u) => remoteIsRepo(u, owner, name));
  } catch {
    return false;
  }
}
