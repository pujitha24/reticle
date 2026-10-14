/**
 * Runs from a worktree land in that worktree's `.reticle/`. Cloud sync visited only the folders
 * of known projects, which name the main checkout, so a worktree's runs were never sent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '@/machine/temp-dir.js';
import { worktreeTwins } from './checkout.js';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'ignore',
  });
};

describe('worktreeTwins', () => {
  let dir: string;
  let main: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-twins-')));
    main = join(dir, 'main');
    git(dir, 'init', '-q', '-b', 'main', main);
    mkdirSync(join(main, 'apps', 'web'), { recursive: true });
    writeFileSync(join(main, 'apps', 'web', 'index.html'), '');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'a', join(dir, 'wt-a'));
    git(main, 'worktree', 'add', '-q', '-b', 'b', join(main, '.claude', 'worktrees', 'b'));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('names the same folder in every other checkout of the repository', () => {
    expect(worktreeTwins(join(main, 'apps', 'web')).sort()).toEqual(
      [
        join(dir, 'wt-a', 'apps', 'web'),
        join(main, '.claude', 'worktrees', 'b', 'apps', 'web'),
      ].sort(),
    );
  });

  it('names the main checkout from a worktree', () => {
    expect(worktreeTwins(join(dir, 'wt-a'))).toContain(main);
  });

  it('is empty without worktrees, and outside git', () => {
    const solo = join(dir, 'solo');
    git(dir, 'init', '-q', solo);
    expect(worktreeTwins(solo)).toEqual([]);
    expect(worktreeTwins(tmpdir())).toEqual([]);
  });
});
