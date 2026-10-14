/**
 * Which git checkout a directory is in, and which checkout is the main one.
 *
 * Agents work in git worktrees. Every worktree of a project is the same project, so it must find
 * the same config, the same daemon and the same cloud link as the main checkout. But it must keep
 * its own results. This reads the two facts that make that possible from the `.git` entry, with no
 * `git` process: a worktree's `.git` is a file that says `gitdir: <main>/.git/worktrees/<name>`.
 *
 * Pure. The caller supplies `readFile` (undefined for a missing file), so core stays free of Node.
 */

/** A git checkout, as read from disk. */
export interface Checkout {
  /** The top directory of this checkout. */
  root: string;
  /** The top directory of the main checkout. Equals `root` when there is no other. */
  mainRoot: string;
  /**
   * The repository's own git directory, which every worktree of it shares (`git rev-parse
   * --git-common-dir`). Two checkouts are worktrees of one repository when this is equal. A bare
   * repository has worktrees but no main checkout, so `mainRoot` cannot tell them apart.
   */
  commonDir: string;
  /** The branch checked out. Absent on a detached HEAD. */
  branch?: string;
  /** True for a linked worktree (`git worktree add`). */
  linked: boolean;
}

/** How far up to walk for a `.git`. A backstop for a deep tree, not a policy. */
const MAX_UP_LEVELS = 50;
const GITDIR_PREFIX = 'gitdir:';
const BRANCH_PREFIX = 'ref: refs/heads/';
const WORKTREES_SEGMENT = 'worktrees';
const GIT_DIR_NAME = '.git';
/** A path that starts with a drive letter. */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

export function checkoutOf(
  dir: string,
  readFile: (path: string) => string | undefined,
): Checkout | undefined {
  const sep = dir.includes('\\') ? '\\' : '/';
  let current = trimEnd(dir, sep);
  for (let level = 0; level <= MAX_UP_LEVELS; level += 1) {
    const head = readFile(`${current}${sep}${GIT_DIR_NAME}${sep}HEAD`);
    if (head !== undefined) {
      return withBranch(
        {
          root: current,
          mainRoot: current,
          commonDir: `${current}${sep}${GIT_DIR_NAME}`,
          linked: false,
        },
        head,
      );
    }
    const pointer = readFile(`${current}${sep}${GIT_DIR_NAME}`);
    if (pointer !== undefined && pointer.trim().startsWith(GITDIR_PREFIX)) {
      return linkedCheckout(
        current,
        pointer.trim().slice(GITDIR_PREFIX.length).trim(),
        sep,
        readFile,
      );
    }
    const parent = parentOf(current, sep);
    if (parent === undefined) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * The same path in the main checkout, when `path` sits in a linked worktree; otherwise undefined.
 *
 * What a fresh worktree does not have yet is often in the main checkout: an uncommitted or
 * git-ignored `.reticle/cloud.json`, or a flow saved there and not yet committed. Callers read the
 * twin only as a fallback, and never write to it.
 */
export function mainCheckoutTwin(
  path: string,
  readFile: (path: string) => string | undefined,
): string | undefined {
  const checkout = checkoutOf(path, readFile);
  if (checkout === undefined || checkout.root === checkout.mainRoot) return undefined;
  return `${checkout.mainRoot}${path.slice(checkout.root.length)}`;
}

/**
 * True when two paths that `checkoutOf` returned name one directory. A Windows path ignores case, and
 * the same folder arrives as `C:\wt\a` from a shell and as `C:/wt/a` from Vite and git.
 */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (!WINDOWS_PATH.test(a) || !WINDOWS_PATH.test(b)) return false;
  return a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase();
}

function linkedCheckout(
  root: string,
  gitdir: string,
  sep: string,
  readFile: (path: string) => string | undefined,
): Checkout {
  const absolute = resolvePath(root, gitdir.split(/[\\/]/).join(sep), sep);
  const parts = absolute.split(sep);
  // `<main>/.git/worktrees/<name>`: a worktree. Anything else (`.git/modules/x`) is a submodule.
  const isWorktree = WORKTREES_SEGMENT === parts[parts.length - 2];
  const gitDirOfRepo = parts.slice(0, -2);
  const commonDir = isWorktree ? gitDirOfRepo.join(sep) : absolute;
  // A bare repository has no main checkout to share; the worktree is its own main checkout.
  const mainRoot =
    isWorktree && GIT_DIR_NAME === gitDirOfRepo[gitDirOfRepo.length - 1]
      ? gitDirOfRepo.slice(0, -1).join(sep)
      : root;
  const head = readFile(`${absolute}${sep}HEAD`);
  const checkout: Checkout = { root, mainRoot, commonDir, linked: isWorktree };
  return head === undefined ? checkout : withBranch(checkout, head);
}

function withBranch(checkout: Checkout, head: string): Checkout {
  const ref = head.trim();
  return ref.startsWith(BRANCH_PREFIX)
    ? { ...checkout, branch: ref.slice(BRANCH_PREFIX.length) }
    : checkout;
}

/** `rel` against `base`, with `.` and `..` folded. An absolute `rel` (POSIX or drive) wins. */
function resolvePath(base: string, rel: string, sep: string): string {
  const absolute = rel.startsWith(sep) || /^[A-Za-z]:/.test(rel);
  const parts = (absolute ? rel : `${base}${sep}${rel}`).split(sep);
  const out: string[] = [];
  for (const part of parts) {
    if ('.' === part || ('' === part && out.length > 0)) continue;
    if ('..' === part) {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join(sep);
}

function parentOf(path: string, sep: string): string | undefined {
  const at = path.lastIndexOf(sep);
  if (at <= 0) return undefined;
  const parent = path.slice(0, at);
  // `C:` alone is not a directory we can append to; stop at the drive root.
  return /^[A-Za-z]:$/.test(parent) ? undefined : parent;
}

function trimEnd(path: string, sep: string): string {
  let end = path.length;
  while (end > 1 && sep === path[end - 1]) end -= 1;
  return path.slice(0, end);
}
