import { describe, expect, it } from 'vitest';
import { checkoutOf, mainCheckoutTwin } from './checkout.js';

/** A fake filesystem: path → contents. A missing path reads as undefined, like a missing file. */
const fs =
  (files: Record<string, string>) =>
  (path: string): string | undefined =>
    files[path];

describe('checkoutOf', () => {
  it('reads a main checkout and its branch', () => {
    const read = fs({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' });
    expect(checkoutOf('/repo/apps/web', read)).toEqual({
      root: '/repo',
      mainRoot: '/repo',
      commonDir: '/repo/.git',
      branch: 'main',
      linked: false,
    });
  });

  it('reads a linked worktree and finds its main checkout', () => {
    const read = fs({
      '/wt/feat-x/.git': 'gitdir: /repo/.git/worktrees/feat-x\n',
      '/repo/.git/worktrees/feat-x/HEAD': 'ref: refs/heads/feat/x\n',
    });
    expect(checkoutOf('/wt/feat-x/apps/web', read)).toEqual({
      root: '/wt/feat-x',
      mainRoot: '/repo',
      commonDir: '/repo/.git',
      branch: 'feat/x',
      linked: true,
    });
  });

  it('resolves a relative gitdir (git worktree --relative-paths)', () => {
    const read = fs({
      '/repo/.claude/worktrees/a/.git': 'gitdir: ../../../.git/worktrees/a',
      '/repo/.git/worktrees/a/HEAD': 'ref: refs/heads/a',
    });
    expect(checkoutOf('/repo/.claude/worktrees/a', read)).toMatchObject({
      root: '/repo/.claude/worktrees/a',
      mainRoot: '/repo',
      commonDir: '/repo/.git',
      linked: true,
    });
  });

  it('reads Windows paths', () => {
    const read = fs({
      'C:\\wt\\b\\.git': 'gitdir: C:/repo/.git/worktrees/b',
      'C:\\repo\\.git\\worktrees\\b\\HEAD': 'ref: refs/heads/b',
    });
    expect(checkoutOf('C:\\wt\\b\\src', read)).toEqual({
      root: 'C:\\wt\\b',
      mainRoot: 'C:\\repo',
      commonDir: 'C:\\repo\\.git',
      branch: 'b',
      linked: true,
    });
  });

  it('gives no branch for a detached HEAD', () => {
    const read = fs({ '/repo/.git/HEAD': '4f1c0ffee\n' });
    expect(checkoutOf('/repo', read)).toEqual({
      root: '/repo',
      mainRoot: '/repo',
      commonDir: '/repo/.git',
      linked: false,
    });
  });

  it('treats a worktree of a bare repository as its own main checkout', () => {
    const read = fs({
      '/wt/c/.git': 'gitdir: /repos/app.git/worktrees/c',
      '/repos/app.git/worktrees/c/HEAD': 'ref: refs/heads/c',
    });
    expect(checkoutOf('/wt/c', read)).toEqual({
      root: '/wt/c',
      mainRoot: '/wt/c',
      commonDir: '/repos/app.git',
      branch: 'c',
      linked: true,
    });
  });

  /** A bare clone with one worktree per branch is a common agent layout. Its worktrees are siblings. */
  it('gives every worktree of a bare repository the same commonDir', () => {
    const read = fs({
      '/wt/a/.git': 'gitdir: /repos/app.git/worktrees/a',
      '/wt/b/.git': 'gitdir: /repos/app.git/worktrees/b',
    });
    expect(checkoutOf('/wt/a', read)?.commonDir).toBe('/repos/app.git');
    expect(checkoutOf('/wt/b', read)?.commonDir).toBe('/repos/app.git');
  });

  it('treats a submodule as its own checkout, not a worktree', () => {
    const read = fs({
      '/repo/vendor/lib/.git': 'gitdir: ../../.git/modules/lib',
      '/repo/.git/modules/lib/HEAD': 'ref: refs/heads/main',
    });
    expect(checkoutOf('/repo/vendor/lib', read)).toEqual({
      root: '/repo/vendor/lib',
      mainRoot: '/repo/vendor/lib',
      commonDir: '/repo/.git/modules/lib',
      branch: 'main',
      linked: false,
    });
  });

  it('returns undefined outside any git repository', () => {
    expect(checkoutOf('/tmp/plain', fs({}))).toBeUndefined();
  });
});

describe('mainCheckoutTwin', () => {
  const read = fs({
    '/wt/feat-x/.git': 'gitdir: /repo/.git/worktrees/feat-x',
    '/repo/.git/HEAD': 'ref: refs/heads/main',
  });

  it('is the same path in the main checkout, for a path in a linked worktree', () => {
    expect(mainCheckoutTwin('/wt/feat-x/apps/web/.reticle', read)).toBe('/repo/apps/web/.reticle');
  });

  it('is undefined in the main checkout itself, and outside git', () => {
    expect(mainCheckoutTwin('/repo/apps/web/.reticle', read)).toBeUndefined();
    expect(mainCheckoutTwin('/tmp/x/.reticle', read)).toBeUndefined();
  });
});
