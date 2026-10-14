/**
 * A flow saved in the main checkout and not yet committed is not in a new git worktree. Replay-first
 * then started from zero in every worktree. The worktree reads the main checkout's flows as a
 * fallback, and writes only to its own `.reticle/`, so its flows travel with its branch.
 *
 * The fallback applies only when `.reticle/` is git-ignored. When git tracks it, the worktree
 * already has every committed flow, and a flow the branch deleted came back from the main checkout.
 */
import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType, QueryBy } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { flowPath } from '@/memory/project/dir/reticle-dir.js';
import { asFlowName } from '@reticlehq/core';
import { FlowStore } from './flows.js';
import type { CompiledProgram } from './recording/tape/recordings.js';

const clock = { now: (): number => 1 };
const click = (name: string): CompiledProgram => ({
  name,
  version: 1,
  steps: [
    {
      tool: 'reticle_act',
      stable: true,
      args: { by: QueryBy.TESTID, value: 'save', action: ActionType.CLICK, args: {} },
    },
  ],
});
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'ignore',
  });
};

async function repoWithWorktree(dir: string, ignored: boolean): Promise<void> {
  const main = join(dir, 'main');
  git(dir, 'init', '-q', '-b', 'main', main);
  await writeFile(join(main, '.gitignore'), ignored ? '.reticle/\n' : 'node_modules\n');
  await new FlowStore(createNodeFileSystem(), join(main, '.reticle'), clock).save(
    click('checkout'),
  );
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', join(dir, 'wt'));
}

describe('FlowStore in a linked git worktree', () => {
  let dir: string;
  let mainRoot: string;
  let wtRoot: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-flow-wt-'));
    mainRoot = join(dir, 'main', '.reticle');
    wtRoot = join(dir, 'wt', '.reticle');
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  describe('when .reticle/ is git-ignored', () => {
    beforeEach(async () => {
      await repoWithWorktree(dir, true);
    });

    it('lists and loads a flow the main checkout saved', async () => {
      const store = new FlowStore(createNodeFileSystem(), wtRoot, clock);
      expect(await store.list()).toEqual(['checkout']);
      expect((await store.load('checkout')).ok).toBe(true);
    });

    it('saves into the worktree, never into the main checkout', async () => {
      const store = new FlowStore(createNodeFileSystem(), wtRoot, clock);
      await store.save(click('refund'));
      expect(existsSync(flowPath(wtRoot, asFlowName('refund')))).toBe(true);
      expect(existsSync(flowPath(mainRoot, asFlowName('refund')))).toBe(false);
      expect(await store.list()).toEqual(['checkout', 'refund']);
    });

    it('writes what a replay learned about a main-checkout flow into the worktree', async () => {
      const store = new FlowStore(createNodeFileSystem(), wtRoot, clock);
      const before = readFileSync(flowPath(mainRoot, asFlowName('checkout')), 'utf8');
      const learned = await store.recordLearned('checkout', [
        { kind: 'duplicate-request', step: 0, state: 'open' },
      ]);
      expect(learned.ok).toBe(true);
      expect(existsSync(flowPath(wtRoot, asFlowName('checkout')))).toBe(true);
      expect(readFileSync(flowPath(mainRoot, asFlowName('checkout')), 'utf8')).toBe(before);
    });
  });

  describe('when git tracks .reticle/', () => {
    beforeEach(async () => {
      await repoWithWorktree(dir, false);
    });

    it('keeps a flow the branch deleted deleted', async () => {
      await rm(flowPath(wtRoot, asFlowName('checkout')));
      const store = new FlowStore(createNodeFileSystem(), wtRoot, clock);
      expect(await store.list()).toEqual([]);
      expect((await store.load('checkout')).ok).toBe(false);
    });
  });
});
