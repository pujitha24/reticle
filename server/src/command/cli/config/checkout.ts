/**
 * The git checkout a directory is in, read from disk. The rule is core's `checkoutOf`; this file
 * only supplies the reads, so every server module asks the same question the same way.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { checkoutOf, samePath, type Checkout } from '@reticlehq/core';

/** Where git keeps one folder for each linked worktree, under the repository's git directory. */
const WORKTREES_DIR = 'worktrees';
/** The file in that folder that names the worktree's `.git`. */
const GITDIR_FILE = 'gitdir';

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // Missing, a directory, or unreadable: not the file we look for.
    return undefined;
  }
};

/** The checkout `dir` is in, or undefined outside git. */
export function checkoutAt(dir: string): Checkout | undefined {
  return checkoutOf(dir, readOrUndefined);
}

/** The top directory of each linked worktree of the repository whose git directory is `commonDir`. */
function linkedWorktreeRoots(commonDir: string): string[] {
  const admin = join(commonDir, WORKTREES_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(admin);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    // `<worktree>/.git`, absolute, or relative to this file when git writes relative paths.
    const pointer = readOrUndefined(join(admin, name, GITDIR_FILE))?.trim();
    return pointer === undefined || 0 === pointer.length
      ? []
      : [dirname(resolve(admin, name, pointer))];
  });
}

/**
 * The same folder in every other checkout of the repository that holds `directory`: the main
 * checkout and each linked worktree. Empty outside git and without worktrees.
 */
export function worktreeTwins(directory: string): string[] {
  const from = checkoutAt(directory);
  if (from === undefined) return [];
  const rel = relative(from.root, directory);
  const roots = new Set([from.mainRoot, ...linkedWorktreeRoots(from.commonDir)]);
  return [...roots].filter((root) => !samePath(root, from.root)).map((root) => join(root, rel));
}

/** True when the repository whose git directory is `commonDir` has a linked worktree. One read. */
export function hasLinkedWorktrees(commonDir: string): boolean {
  try {
    return readdirSync(join(commonDir, WORKTREES_DIR)).length > 0;
  } catch {
    return false;
  }
}
