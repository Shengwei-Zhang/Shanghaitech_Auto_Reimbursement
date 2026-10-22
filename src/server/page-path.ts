import fs from 'node:fs';
import path from 'node:path';

/** The page's address follows the checked-out branch: deploy and main (the released code) serve
 * /Reim-Copilot, any other branch (dev) serves /Reim-Copilot. Read once when the server starts. */
export const RELEASE_PAGE = '/Reim-Copilot';
export const DEV_PAGE = '/Reim-Copilot';
const RELEASE_BRANCHES = new Set(['deploy', 'main']);

/** The branch in `root`'s .git/HEAD (a worktree's .git file points to its own HEAD); '' when unknown. */
export function currentBranch(root: string): string {
  try {
    const dotGit = path.join(root, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!pointer) return '';
      gitDir = path.resolve(root, pointer);
    }
    return fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').match(/^ref:\s*refs\/heads\/(.+)$/m)?.[1]?.trim() ?? '';
  } catch { return ''; }
}

export function pagePath(root = path.resolve(__dirname, '../..')): string {
  return RELEASE_BRANCHES.has(currentBranch(root)) ? RELEASE_PAGE : DEV_PAGE;
}
