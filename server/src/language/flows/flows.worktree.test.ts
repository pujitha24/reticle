/**
 * A flow saved in the main checkout and not yet committed is not in a new git worktree. Replay-first
 * then started from zero in every worktree. The worktree reads the main checkout's flows as a
 * fallback, and writes only to its own `.reticle/`, so its flows travel with its branch.
 */
import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

describe('FlowStore in a linked git worktree', () => {
  let dir: string;
  let mainRoot: string;
  let wtRoot: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-flow-wt-'));
    await mkdir(join(dir, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
    await writeFile(join(dir, 'main', '.git', 'HEAD'), 'ref: refs/heads/main');
    await mkdir(join(dir, 'wt'), { recursive: true });
    await writeFile(
      join(dir, 'wt', '.git'),
      `gitdir: ${join(dir, 'main', '.git', 'worktrees', 'wt')}`,
    );
    mainRoot = join(dir, 'main', '.reticle');
    wtRoot = join(dir, 'wt', '.reticle');
    await new FlowStore(createNodeFileSystem(), mainRoot, clock).save(click('checkout'));
  });

  afterEach(async () => {
    await removeTempDir(dir);
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
});
