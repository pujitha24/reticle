/**
 * A captured prompt never enters telemetry.
 *
 * `reticle hook prompt` runs on every prompt the user sends, and the prompt is the user's own words.
 * Install telemetry counts commands; it must not learn that a prompt existed, let alone read it. Two
 * routes could carry it there, and each is closed here: the CLI-run report every command passes
 * through, and the emitter itself while a prompt is captured.
 */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryEventSchema } from '@reticlehq/core';

const emitted = vi.hoisted(() => [] as unknown[]);
const reported = vi.hoisted(() => [] as unknown[]);
const hookRuns = vi.hoisted(() => [] as unknown[]);

vi.mock('./telemetry.js', async (original) => ({
  ...(await original<typeof import('./telemetry.js')>()),
  getTelemetry: () => ({
    firstRun: true,
    emit: (...args: unknown[]) => {
      emitted.push(args);
      return Promise.resolve();
    },
  }),
}));
vi.mock('./cli-telemetry.js', async (original) => ({
  ...(await original<typeof import('./cli-telemetry.js')>()),
  reportCliRun: (argv: unknown) => {
    reported.push(argv);
  },
}));
vi.mock('@/command/cli/hook/hook-command.js', async (original) => ({
  ...(await original<typeof import('@/command/cli/hook/hook-command.js')>()),
  handleHook: (argv: unknown) => {
    hookRuns.push(argv);
    return Promise.resolve(0);
  },
}));

const MARKER = 'the refund must reach the customer within five days';

afterEach(() => {
  emitted.length = 0;
  reported.length = 0;
  hookRuns.length = 0;
  vi.restoreAllMocks();
});

describe('a captured prompt and telemetry', () => {
  it('`reticle hook` is dispatched before the command is reported', async () => {
    const { main } = await import('@/command/cli.js');
    const argv = process.argv;
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.argv = [argv[0] ?? 'node', 'reticle', 'hook', 'prompt', '--agent', 'claude-code'];
    try {
      main();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.argv = argv;
    }
    expect(hookRuns).toEqual([['prompt', '--agent', 'claude-code']]);
    expect(reported).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('capturing a prompt calls no emitter', async () => {
    const { capturePrompt } = await import('@/command/cli/hook/prompt-hook.js');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-no-telemetry-')));
    writeFileSync(join(dir, '.reticle.json'), JSON.stringify({ projectId: 'p-1' }));
    const out = capturePrompt('claude-code', JSON.stringify({ prompt: MARKER, cwd: dir }), {
      cwd: dir,
      env: {},
      now: () => 1,
    });
    // The control: the prompt WAS captured, so an empty emitter is not an idle hook.
    expect(out.written).toHaveLength(1);
    expect(readFileSync(join(dir, '.reticle', 'request.json'), 'utf8')).toContain(MARKER);
    expect(emitted).toEqual([]);
  });

  it('no event field can carry a prompt', () => {
    const fields = Object.keys(TelemetryEventSchema.shape);
    for (const name of ['prompt', 'request', 'statements', 'userPrompt'])
      expect(fields, name).not.toContain(name);
  });
});
