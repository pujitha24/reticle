/**
 * The git checkout a directory is in, read from disk. The rule is core's `checkoutOf`; this file
 * only supplies the reads, so every server module asks the same question the same way.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutOf, type Checkout } from '@reticlehq/core';

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

/** True when the repository at `mainRoot` has at least one linked worktree. One directory read. */
export function hasLinkedWorktrees(mainRoot: string): boolean {
  try {
    return readdirSync(join(mainRoot, '.git', 'worktrees')).length > 0;
  } catch {
    return false;
  }
}
