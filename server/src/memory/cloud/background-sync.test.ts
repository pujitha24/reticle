/**
 * The daemon's background sync: it sends a signed-in user's linked project without anybody running
 * `reticle sync`, and it sends nothing at all otherwise.
 *
 * The clock is vitest's fake one and the network is a recording function, so every assertion is a
 * count of calls, never a duration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { attachCloudSync, startSyncDaemon } from './sync-daemon.js';
import {
  BackgroundSyncState,
  backgroundSyncGate,
  localFingerprint,
  type BackgroundSyncGate,
} from './background-sync.js';
import type { ProjectCloud } from './cloud-config.js';
import { log } from '@/log.js';

vi.mock('@/hooks/hook-emit.js', () => ({ emitSyncHook: vi.fn() }));
vi.mock('@/log.js', () => ({ log: vi.fn() }));

const URL_LINKED = 'http://localhost:8890';
const LINKED: ProjectCloud = {
  config: { url: URL_LINKED, apiKey: 'rk_test' },
  policy: { runs: true, memory: true, flows: true, capsules: true, screenshots: true },
  verify: 'local',
  projectId: 'demo',
  link: `${URL_LINKED}::demo`,
};
const ON: BackgroundSyncGate = { state: BackgroundSyncState.ON, why: 'on', credential: 'k1' };
const INTERVAL = 30_000;

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-bg-')));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const writeRun = (runId: string, request: string): void => {
  mkdirSync(join(root, 'runs'), { recursive: true });
  writeFileSync(
    join(root, 'runs', `${runId}.json`),
    JSON.stringify({ runId, context: { request, statements: [], shared: true } }),
  );
};

/** A platform that keeps what it is sent, and can be told to fail. */
function platform() {
  const calls: { method: string; url: string; body?: string }[] = [];
  const held = new Set<string>();
  let answer: 'ok' | 'down' | 'refused' = 'ok';
  const request = (
    url: string,
    init: { method: string; body?: string },
  ): Promise<{ status: number; text: string }> => {
    calls.push({
      method: init.method,
      url,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if ('down' === answer) return Promise.reject(new Error('connect ECONNREFUSED'));
    if ('refused' === answer) return Promise.resolve({ status: 401, text: 'bad key' });
    if (url.endsWith('/v1/sync/status')) {
      const status = { knownRunIds: [...held], stateHashes: {}, accepts: { derived: [] } };
      return Promise.resolve({ status: 200, text: JSON.stringify(status) });
    }
    if ('POST' === init.method) {
      const runs = (JSON.parse(init.body ?? '{}') as { runs?: { runId: string }[] }).runs ?? [];
      for (const run of runs) held.add(run.runId);
      const result = { runs: { accepted: runs.length, rejected: [] } };
      return Promise.resolve({ status: 200, text: JSON.stringify(result) });
    }
    return Promise.resolve({ status: 200, text: JSON.stringify({ triage: [], cursor: '0:' }) });
  };
  return {
    request,
    calls,
    pushes: () => calls.filter((c) => 'POST' === c.method),
    set: (next: typeof answer) => {
      answer = next;
    },
  };
}

function daemon(server: ReturnType<typeof platform>, gate: () => BackgroundSyncGate) {
  return startSyncDaemon({
    reticleRoot: root,
    cloud: () => Promise.resolve(LINKED),
    request: server.request,
    intervalMs: INTERVAL,
    gate,
    fingerprint: localFingerprint,
    random: () => 0.5,
  });
}

describe('background sync', () => {
  it('makes no call while signed out', async () => {
    const server = platform();
    writeRun('r1', 'a request');
    const d = daemon(server, () => ({ state: BackgroundSyncState.SIGNED_OUT, why: 'signed out' }));
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(server.calls).toHaveLength(0);
    expect(d.background().state).toBe(BackgroundSyncState.SIGNED_OUT);
    d.stop();
  });

  it('makes no call when switched off', async () => {
    const server = platform();
    writeRun('r1', 'a request');
    const d = daemon(server, () => ({ state: BackgroundSyncState.OPTED_OUT, why: 'off' }));
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(server.calls).toHaveLength(0);
    d.stop();
  });

  it('makes no call while nothing changed', async () => {
    const server = platform();
    writeRun('r1', 'a request');
    const d = daemon(server, () => ON);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(server.pushes()).toHaveLength(1);
    const after = server.calls.length;
    // Four more looks, well inside the pull period: nothing local moved, so nothing is asked.
    await vi.advanceTimersByTimeAsync(4 * INTERVAL);
    expect(server.calls).toHaveLength(after);
    d.stop();
  });

  it('sends a new prompt within one interval, once, and only the change', async () => {
    const server = platform();
    writeRun('r1', 'the first request');
    const d = daemon(server, () => ON);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(server.pushes()).toHaveLength(1);
    writeRun('r2', 'the checkout must show the total');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const pushes = server.pushes();
    expect(pushes).toHaveLength(2);
    const sent = JSON.parse(pushes[1]?.body ?? '{}') as { runs: { runId: string }[] };
    expect(sent.runs.map((run) => run.runId)).toEqual(['r2']);
    expect(pushes[1]?.body).toContain('the checkout must show the total');
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    expect(server.pushes()).toHaveLength(2);
    d.stop();
  });

  it('stops on a refused key, and starts again after a new sign-in', async () => {
    const server = platform();
    server.set('refused');
    writeRun('r1', 'a request');
    let gate = ON;
    const d = daemon(server, () => gate);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const refusedCalls = server.calls.length;
    expect(refusedCalls).toBeGreaterThan(0);
    writeRun('r2', 'another request');
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(server.calls, 'nothing more under the refused sign-in').toHaveLength(refusedCalls);
    expect(d.background().state).toBe(BackgroundSyncState.REFUSED);
    server.set('ok');
    gate = { ...ON, credential: 'k2' };
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(server.pushes().length).toBeGreaterThan(0);
    expect(d.background().state).toBe(BackgroundSyncState.ON);
    d.stop();
  });

  it('backs off on a network error, and the next success clears it', async () => {
    const server = platform();
    server.set('down');
    writeRun('r1', 'a request');
    const d = daemon(server, () => ON);
    await vi.advanceTimersByTimeAsync(20 * INTERVAL);
    // A failed cycle makes two calls, so one cycle per interval would be forty. Doubling waits
    // leave a handful.
    expect(server.calls.length).toBeLessThanOrEqual(10);
    expect(d.background().failures).toBeGreaterThan(1);
    expect(d.background().lastError).toBeDefined();
    server.set('ok');
    await d.syncNow();
    expect(d.background().failures).toBe(0);
    expect(d.background().lastError).toBeUndefined();
    d.stop();
  });
});

/*
 * Found in the e2e battery: a daemon knows every project ever opened on the machine, and it wrote
 * one `unlinked` line for each at start, next to the `reticle_cloud_unsynced_root` line that
 * already says the same thing. A project that was never linked says nothing new.
 */
describe('what background sync logs', () => {
  const lines = () =>
    vi.mocked(log).mock.calls.filter(([event]) => 'reticle_background_sync' === event);

  it('says nothing for a project that was never linked, and one line once it is', async () => {
    vi.mocked(log).mockClear();
    let gate: BackgroundSyncGate = { state: BackgroundSyncState.UNLINKED, why: 'not linked' };
    const d = daemon(platform(), () => gate);
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(lines()).toHaveLength(0);
    gate = ON;
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(lines()).toHaveLength(1);
    d.stop();
  });
});

describe('where background sync sends', () => {
  it('never takes the address from the environment, only from the link', async () => {
    vi.useRealTimers();
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-bg-home-')));
    const server = platform();
    writeRun('r1', 'a request');
    // An environment that names another platform, with a key, as a repository `.env` can.
    const env = { RETICLE_API_KEY: 'rk_env', RETICLE_CLOUD_URL: 'https://prod.example' };
    const start = () =>
      attachCloudSync({
        fs: createNodeFileSystem(),
        reticleRoot: root,
        homeDir: home,
        env,
        otherRoots: () => [],
        signedIn: () => 'token',
        request: server.request,
        intervalMs: INTERVAL,
      });
    const unlinked = start();
    await unlinked.syncNow();
    unlinked.stop();
    expect(unlinked.background().state).toBe(BackgroundSyncState.UNLINKED);
    expect(server.calls, 'an unlinked project sends nothing, whatever the env says').toEqual([]);

    writeFileSync(join(root, 'cloud.json'), JSON.stringify({ projectId: 'demo', url: URL_LINKED }));
    mkdirSync(join(home, '.reticle'), { recursive: true });
    writeFileSync(
      join(home, '.reticle', 'credentials.json'),
      JSON.stringify({ [`${URL_LINKED}::demo`]: 'rk_local' }),
    );
    const linked = start();
    await linked.syncNow();
    linked.stop();
    expect(linked.background().state).toBe(BackgroundSyncState.ON);
    expect(server.pushes()).toHaveLength(1);
    expect(server.calls.every((c) => c.url.startsWith(URL_LINKED))).toBe(true);
  });
});

describe('the gate', () => {
  const gate = (overrides: Partial<Parameters<typeof backgroundSyncGate>[0]> = {}) =>
    backgroundSyncGate({
      reticleRoot: root,
      cloud: LINKED,
      env: {},
      signedIn: () => 'token',
      ...overrides,
    }).state;

  it('is on only when linked, keyed, signed in and not switched off', () => {
    expect(gate()).toBe(BackgroundSyncState.ON);
    expect(gate({ signedIn: () => undefined })).toBe(BackgroundSyncState.SIGNED_OUT);
    expect(gate({ cloud: { ...LINKED, config: null } })).toBe(BackgroundSyncState.SIGNED_OUT);
    const { link: _link, ...envOnly } = LINKED;
    expect(gate({ cloud: envOnly })).toBe(BackgroundSyncState.UNLINKED);
    expect(gate({ env: { RETICLE_BACKGROUND_SYNC: '0' } })).toBe(BackgroundSyncState.OPTED_OUT);
  });

  it('honours the project setting', () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-bg-project-')));
    writeFileSync(join(project, '.reticle.json'), JSON.stringify({ backgroundSync: false }));
    expect(gate({ reticleRoot: join(project, '.reticle') })).toBe(BackgroundSyncState.OPTED_OUT);
  });
});
