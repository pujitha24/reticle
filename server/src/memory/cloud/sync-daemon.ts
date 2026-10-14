/**
 * Automatic sync, for the session nobody thinks about.
 *
 * Somebody runs Reticle all morning. Every tool call rewrites the impact record; every verification
 * writes a run. If sync is a command a human types, the dashboard is stale for exactly as long as
 * they are busy — which is precisely when the numbers on it would have been worth looking at.
 *
 * So the daemon does it. Not a new process, not a thing to remember: the daemon is already running
 * for the whole session (it is what the agent talks to), so it is the only place where "sync while
 * work is happening" costs nobody anything.
 *
 * ── THE THREE RULES THAT KEEP IT INVISIBLE ────────────────────────────────────────────────────
 * QUIET WHEN IDLE. A cycle on an unchanged session is one small GET and nothing else. That is what
 * makes a one-minute timer affordable; it is also why the timer is not adaptive — a scheme that
 * "backs off when idle" is complexity paid for a cost that is already near zero.
 *
 * NEVER IN THE WAY. Nothing here is awaited by a tool call. A sync that can slow down or fail a
 * verification would be a sync worth switching off, and the local record is authoritative anyway.
 *
 * SILENT UNLESS IT MATTERS. A failed cycle is logged once per NEW error, not once per minute: a
 * laptop on a train would otherwise fill the log with the same line four hundred times and teach
 * everyone to ignore it.
 */
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { syncRequest } from './cloud-sync.js';
import { log } from '@/log.js';
import { homedir } from 'node:os';
import { emitSyncHook } from '@/hooks/hook-emit.js';
import {
  MemoryReadHeader,
  MemoryReadPurpose,
  memoryReadUrl,
  scopedMemoryEntries,
} from './memory-scope.js';
import { IntentShardStore } from '@/memory/intent/intent-shard-store.js';
import {
  applySettledWords,
  keptWordsInRequest,
  settledWordsIn,
} from '@/memory/intent/settled-words.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { flushPendingWrites } from '@/hooks/hook-bus.js';
import { describeSync, runSyncCycle, type SyncReport } from './sync-cycle.js';
import { diskSink, diskSource, readCloudState } from './sync-disk.js';
import { CLOUD_LINK_FILE, resolveProjectCloud, type ProjectCloud } from './cloud-config.js';
import { watch } from 'node:fs';
import {
  BackgroundSyncState,
  backgroundSyncGate,
  localFingerprint,
  type BackgroundSyncGate,
} from './background-sync.js';
import { unmatchedRoots, unsyncedRoots, type UnsyncedRoot } from './unsynced-roots.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';

/**
 * How often the daemon looks. A look is LOCAL: with a fingerprint (see `localFingerprint`) a tick
 * on which nothing changed makes no network call at all, so a prompt the agent hook captured, or a
 * run just written, reaches the platform within one interval without a minute of idle polling.
 */
const DAEMON_SYNC_INTERVAL_MS = 30_000;

/**
 * How long nothing local may change before the daemon still asks the platform for decisions made
 * there (triage, settled words). The pull used to ride on EVERY idle tick, once a minute; the
 * decisions it brings are read by the next run, so five minutes of latency costs nobody a verdict.
 */
const PULL_EVERY_MS = 5 * 60_000;

/**
 * The longest a failing sync waits before it tries again. A network error doubles the wait from the
 * interval up to this, with jitter, so a laptop offline for an hour makes a few calls, not 120.
 */
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * The cadence while something is actually happening.
 *
 * A fixed minute is the wrong shape for both states it has to cover. During a drive the ledger
 * changes on every tool call and a minute of lag is what makes a dashboard feel dead; idle, a minute
 * is already more often than nothing has changed deserves.
 *
 * So the interval follows the work: a cycle that MOVED something earns the fast rate, a cycle that
 * moved nothing backs off to the slow one. No session plumbing and no new configuration — activity
 * is inferred from what the last cycle actually sent, which is the only honest evidence available.
 *
 * Deliberately not per-tool-call. A push in the tool path would put the network in the agent's inner
 * loop, and verification working with the network down is a promise this product makes.
 */
const DAEMON_SYNC_ACTIVE_INTERVAL_MS = 5_000;

/** Given to the first cycle so a freshly-started daemon does not race the session that woke it. */
const FIRST_CYCLE_DELAY_MS = 5_000;

/**
 * How long a nudge waits before cycling.
 *
 * Long enough to COALESCE — a battery that writes six runs in a second must cause one cycle, not
 * six — and short enough that finishing a verification and looking at the dashboard feels like one
 * action. Not zero: a run artifact is renamed into place and the sibling records it implies are
 * written just after, so cycling on the very first byte would ship a bundle that is missing them.
 */
const NUDGE_DELAY_MS = 1_500;

/**
 * How long a flush waits for a cycle already in flight before running its own.
 *
 * Shutdown budget, not a sync budget: every call inside a cycle already carries its own timeout, so
 * this only bounds the WAIT. Generous enough for an ordinary cycle to finish, short enough that a
 * stalled one cannot hold a daemon open.
 */
const FLUSH_WAIT_MS = 3_000;
const FLUSH_POLL_MS = 25;

interface SyncDaemonDeps {
  reticleRoot: string;
  /** Resolved per tick, not once: a repo linked while the daemon is alive starts syncing itself. */
  cloud: () => Promise<ProjectCloud>;
  /**
   * Every OTHER `.reticle` root on this machine that might be linked.
   *
   * One daemon serves many projects — that is what `artifactRootFor` exists for — and this loop
   * pushed exactly one of them: whichever directory the daemon happened to be started in. Every
   * other linked repo went silent, and silent is indistinguishable from "nobody verified anything",
   * which is the worst possible failure for a dashboard somebody is deciding budget on.
   *
   * Optional: a caller that does not supply it gets exactly the old single-root behaviour.
   */
  otherRoots?: () => Promise<readonly string[]>;
  /** Resolve the link for a root that is not this daemon's own. Required to use `otherRoots`. */
  cloudFor?: (root: string) => Promise<ProjectCloud>;
  now?: () => number;
  intervalMs?: number;
  /**
   * Call `onChange` when this root's link file changes; returns how to stop. A re-link was read only
   * on the next idle tick, so a daemon kept syncing to the old link for up to a minute.
   */
  watchLink?: (onChange: () => void) => () => void;
  /** Injected for the test; the real one is `fetch`. */
  request?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ status: number; text: string }>;
  /**
   * May this root's work be sent now (opt-outs, link, sign-in)? Asked for every root on every tick.
   * Absent: every resolved link may send, which is how `startSyncDaemon` behaved before.
   */
  gate?: (root: string, cloud: ProjectCloud) => BackgroundSyncGate;
  /** What a cycle would read, summarised. Absent: every tick goes to the network. */
  fingerprint?: (root: string) => string;
  /** Jitter for the backoff, in [0, 1). Injected: pure logic never calls `Math.random`. */
  random?: () => number;
}

/** Where the background sync of the daemon's own project stands, for `doctor` and the tests. */
export interface BackgroundSyncReport {
  state: BackgroundSyncState;
  why: string;
  /** Network failures in a row; the backoff grows with it. */
  failures: number;
  lastError?: string;
  lastPushAt?: number;
}

export interface SyncDaemon {
  /** Run one cycle now, whatever the timer is doing. Returns undefined when not linked. */
  syncNow: () => Promise<SyncReport | undefined>;
  /**
   * Something worth shipping just landed — cycle soon rather than at the next tick.
   *
   * A verification RUN is the artifact people wait on, and making them wait up to a full interval
   * for it is the difference between a dashboard that reflects the work and one that lags it. The
   * counters keep the timer: they are a rolling aggregate, and a write per tool call to move a
   * number nobody is watching that second is exactly the cost the interval exists to avoid.
   *
   * Coalescing, never additive: many nudges in a burst collapse into one cycle.
   */
  nudge: () => void;
  stop: () => void;
  /**
   * Stop, but send what is still owed first.
   *
   * `stop()` cancels the pending timer, and the last thing a session writes is the run artifact the
   * whole drive produced — so a daemon asked to close moments after a verdict dropped the one push
   * anybody was waiting on. Measured against app.reticle.sh: a drive wrote its run, the daemon
   * exited, and the dashboard's newest row stayed three weeks old.
   *
   * Bounded, because shutdown is not allowed to hang: an in-flight cycle is waited out only until
   * the deadline, and a cycle that cannot finish in time is simply the interval's problem next
   * time — the artifact is still on disk and the next daemon for this project sends it.
   */
  flush: () => Promise<void>;
  /**
   * Every root this daemon knows with runs the platform does not have, as of the last cycle — linked
   * or not. An unlinked one is the case nothing will ever send, and it used to be skipped silently.
   */
  unsyncedRoots: () => readonly UnsyncedRoot[];
  /** Where the background sync of this daemon's own root stands. */
  background: () => BackgroundSyncReport;
}

/** A failed status, push or pull that says the platform refused the credential. */
const AUTH_REFUSED = /^(?:status|sync|pull) 40[13]\b/;

/** Whether a cycle landed or collected anything — what earns the fast interval and a log line. */
const movedAnything = (report: SyncReport): boolean =>
  report.runsSent > 0 ||
  report.flowsSent > 0 ||
  report.capsulesSent > 0 ||
  report.derivedSent.length > 0 ||
  report.pulled > 0;

const defaultRequest = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; text: string }> => syncRequest(url, init);

/**
 * Start the loop. Safe to call for an UNLINKED project: it resolves the link on every tick and does
 * nothing until one appears, which is what lets `reticle link` take effect without a restart.
 */
export function startSyncDaemon(deps: SyncDaemonDeps): SyncDaemon {
  const intervalMs = deps.intervalMs ?? DAEMON_SYNC_INTERVAL_MS;
  // Never slower than the idle rate: a deployment that lengthens the interval means "sync less", and
  // an active burst must not quietly re-introduce the cost it was lowering.
  const activeIntervalMs = Math.min(DAEMON_SYNC_ACTIVE_INTERVAL_MS, intervalMs);
  const now = deps.now ?? ((): number => Date.now());
  const request = deps.request ?? defaultRequest;
  // No jitter unless one is injected: the daemon passes `Math.random`.
  const random = deps.random ?? ((): number => 0.5);
  /** Network failures in a row, for the backoff. Cleared by the next success. */
  let failures = 0;
  /** Per root, the credential the platform refused (401/403). Stopped until the sign-in changes. */
  const refusedUnder = new Map<string, string>();
  /** Per root, the fingerprint of what the last successful cycle saw, and when it ran. */
  const sent = new Map<string, { fingerprint: string; at: number }>();
  /** Per root, the gate as of this tick. */
  const gates = new Map<string, BackgroundSyncGate>();
  /** Per root, the state last logged: one line per change, never one per tick. */
  const loggedState = new Map<string, string>();
  let lastPushAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  /** The last error already reported. Repeats are swallowed so an offline laptop stays quiet. */
  let reportedError: string | undefined;
  /**
   * Whether the last cycle found a link — undefined until the first one has looked.
   *
   * An unlinked project used to sync nothing and say nothing, which is indistinguishable from a
   * working sync until somebody notices the dashboard is hours behind. Observed for real: the
   * daemon was started from a sibling repo that had never been linked, so every call for an entire
   * session was recorded into THAT repo's ledger and pushed nowhere, and the first evidence was a
   * stale number on a dashboard nobody had reason to distrust.
   *
   * Announced on the FIRST cycle and on every change after it, so `reticle link` mid-session says
   * so too. Once per transition, never per tick — a line every minute is a line people stop reading.
   */
  let wasLinked: boolean | undefined;
  /** The project the last cycle synced to: a re-link to another one is announced too. */
  let wasProject: string | null | undefined;
  /** The last count logged per root: a root is announced when its count changes, never per tick. */
  const announced = new Map<string, number>();
  let unsynced: readonly UnsyncedRoot[] = [];
  /** Which roots pushed this cycle, and whether each is linked by its own link file. */
  let rootsLinked = new Map<string, boolean>();
  /** The linked roots that send flows: a link with `sync.flows` off keeps every flow local. */
  let rootsSendFlows = new Set<string>();

  /**
   * Count what every root still owes, and say once per change where runs sit that nothing sends.
   * Linked roots are listed too (the platform report and `doctor` read them), but only an unlinked
   * one earns a log line: a linked root's pending runs are the next cycle's job.
   */
  const refreshUnsynced = async (): Promise<void> => {
    const linked = rootsLinked;
    const sendsFlows = rootsSendFlows;
    unsynced = await unsyncedRoots(
      // With what no project claimed, which no cycle pushes: the dashboard's unsent list left it out.
      [...linked.keys(), ...unmatchedRoots(homedir())],
      (r) => Promise.resolve(true === linked.get(r)),
      (r) => Promise.resolve(sendsFlows.has(r)),
    );
    for (const entry of unsynced) {
      const held = entry.runs + entry.flows;
      if (entry.linked || announced.get(entry.root) === held) continue;
      announced.set(entry.root, held);
      log('reticle_cloud_unsynced_root', {
        root: entry.root,
        runs: entry.runs,
        flows: entry.flows,
        linked: entry.linked,
        fix: "run `reticle connect` in that folder's project: this work is on this machine only",
      });
    }
  };

  /**
   * The cloud as this tick may use it: unchanged when the gate lets the root send, else with no
   * config, which every caller below already reads as "send nothing". A credential the platform
   * refused stays refused until the sign-in or the key changes.
   */
  const admit = (root: string, cloud: ProjectCloud): ProjectCloud => {
    if (deps.gate === undefined) return cloud;
    let gate = deps.gate(root, cloud);
    if (BackgroundSyncState.ON === gate.state && gate.credential !== undefined) {
      if (refusedUnder.get(root) === gate.credential) {
        gate = {
          state: BackgroundSyncState.REFUSED,
          why: 'the platform refused this sign-in: run `reticle login` again',
        };
      } else refusedUnder.delete(root);
    }
    gates.set(root, gate);
    if (loggedState.get(root) !== gate.state) {
      loggedState.set(root, gate.state);
      log('reticle_background_sync', { root, state: gate.state, why: gate.why });
    }
    return BackgroundSyncState.ON === gate.state ? cloud : { ...cloud, config: null };
  };

  /** Stop sending for this root until its sign-in changes. */
  const refuse = (root: string): void => {
    const credential = gates.get(root)?.credential;
    if (credential !== undefined) refusedUnder.set(root, credential);
  };

  /** One root's bundle. The state, source and sink are already per-root; only the caller was not. */
  const pushRoot = async (
    root: string,
    cloud: ProjectCloud,
    force = false,
  ): Promise<SyncReport | undefined | null> => {
    if (null === cloud.config) return undefined;
    // Nothing changed here since the last good cycle, and the pull is not due: no network at all.
    const fingerprint = deps.fingerprint?.(root);
    const last = sent.get(root);
    if (
      !force &&
      fingerprint !== undefined &&
      last !== undefined &&
      last.fingerprint === fingerprint &&
      now() - last.at < PULL_EVERY_MS
    )
      return null;
    const report = await sendRoot(root, cloud);
    if (fingerprint !== undefined && report.ok && report.error === undefined)
      sent.set(root, { fingerprint, at: now() });
    if (report.error !== undefined && AUTH_REFUSED.test(report.error)) refuse(root);
    return report;
  };

  const sendRoot = async (root: string, cloud: ProjectCloud): Promise<SyncReport> => {
    if (null === cloud.config) throw new Error('sendRoot needs a linked cloud');
    const full = diskSource(root);
    // The team's decisions come down too: an author's record kept the words a maintainer set aside,
    // and re-sent them every cycle as a new disagreement.
    if (cloud.policy.memory)
      await pullSettledWords(root, cloud.config, cloud.projectId).catch(() => 0);
    return runSyncCycle({
      config: cloud.config,
      ...(cloud.link === undefined ? {} : { link: cloud.link }),
      // Flows deleted here are deleted there, for the project they were sent to.
      ...(cloud.policy.flows && null !== cloud.projectId ? { projectId: cloud.projectId } : {}),
      source: {
        runs: () => (cloud.policy.runs ? full.runs() : []),
        flows: () => (cloud.policy.flows ? full.flows() : []),
        capsules: () => (cloud.policy.capsules ? full.capsules() : []),
        derived: (kind) => (cloud.policy.memory ? full.derived(kind) : undefined),
        ...(cloud.policy.screenshots && full.screenshot !== undefined
          ? { screenshot: full.screenshot }
          : {}),
      },
      sink: diskSink(root),
      state: readCloudState(root),
      now,
      request,
    });
  };

  /** Bring the dashboard's memory decisions down to this root's records. Returns how many changed. */
  const pullSettledWords = async (
    root: string,
    config: { url: string; apiKey: string },
    projectId: string | null,
  ): Promise<number> => {
    const res = await request(memoryReadUrl(config.url, { projectId }), {
      method: 'GET',
      // The sync, not an agent: without this every cycle counted as an agent consulting memory.
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        [MemoryReadHeader.PURPOSE]: MemoryReadPurpose.SYNC,
      },
    });
    if (200 !== res.status) return 0;
    const entries = scopedMemoryEntries(JSON.parse(res.text) as unknown, projectId) ?? [];
    const settled = settledWordsIn(entries);
    await keptWordsInRequest(reticleDirPaths(root).request, settled);
    return applySettledWords(new IntentShardStore(createNodeFileSystem(), root, { now }), settled);
  };

  /**
   * Push every other linked root this machine knows about.
   *
   * Isolated per root on purpose. A revoked credential, a deleted directory or an unreachable
   * self-hosted server in ONE repo is a fact about that repo; letting it throw would take the
   * daemon's own push down with it and turn one broken link into a machine-wide outage.
   */
  const syncOtherRoots = async (): Promise<void> => {
    const roots = deps.otherRoots;
    const cloudFor = deps.cloudFor;
    if (roots === undefined || cloudFor === undefined) return;
    let list: readonly string[] = [];
    try {
      list = await roots();
    } catch {
      // Enumeration is best-effort: a registry that cannot be read must not stop this daemon
      // syncing the root it is standing in.
      return;
    }
    for (const root of list) {
      if (root === deps.reticleRoot) continue;
      rootsLinked.set(root, false);
      try {
        const cloud = admit(root, await cloudFor(root));
        // Linked HERE, by its own link file. An unlinked root resolves to the environment's key,
        // which is the right answer for the root this daemon stands in and somebody else's project
        // for every other one: a daemon started with RETICLE_API_KEY pushed every project this
        // machine had seen into that one, a status and a pull per root on every cycle.
        // Never silently: `refreshUnsynced` names this root if it holds runs.
        if (null === cloud.config || null === cloud.projectId) continue;
        rootsLinked.set(root, true);
        if (cloud.policy.flows) rootsSendFlows.add(root);
        const report = await pushRoot(root, cloud);
        if (report === undefined || null === report) continue;
        if (report.error !== undefined) {
          log('reticle_cloud_sync_failed', { root, error: report.error });
          continue;
        }
        if (!report.ok) log('reticle_cloud_sync_failed', { root, error: describeSync(report) });
        const moved = movedAnything(report);
        // The root is NAMED here and not in the single-root log below, because with several repos
        // reporting, "synced 3 runs" without a directory is not an answer to "synced from where".
        if (moved) log('reticle_cloud_synced', { root, summary: describeSync(report) });
      } catch (error: unknown) {
        log('reticle_cloud_sync_failed', {
          root,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const cycle = async (force = false): Promise<SyncReport | undefined> => {
    // Overlap guard: a slow cycle must not have a second one started on top of it, or two bundles
    // race and the cursor written by the loser silently rewinds the winner's progress.
    if (running) return undefined;
    running = true;
    rootsLinked = new Map();
    rootsSendFlows = new Set();
    try {
      const cloud = admit(deps.reticleRoot, await deps.cloud());
      const linked = null !== cloud.config;
      const own = deps.reticleRoot;
      rootsLinked.set(own, linked);
      if (linked && cloud.policy.flows) rootsSendFlows.add(own);
      // With a gate, `admit` already said why once per change; this would say "run connect" to
      // somebody who only signed out or switched sync off.
      if (
        deps.gate === undefined &&
        (linked !== wasLinked || (linked && cloud.projectId !== wasProject))
      ) {
        wasLinked = linked;
        wasProject = cloud.projectId;
        if (linked)
          log('reticle_cloud_linked', {
            projectId: cloud.projectId,
            root: deps.reticleRoot,
          });
        // Names the ROOT, because the answer is almost always "the daemon is not where you think it
        // is" — and a message that omits the directory sends people to check their key instead.
        else
          log('reticle_cloud_unlinked', {
            root: deps.reticleRoot,
            fix: 'run `reticle connect` in this directory, or start the daemon in the linked one — nothing is being synced from here',
          });
      }
      // Every OTHER linked root, first. Their failures are logged and never abort this daemon's own
      // push: one repo whose credential was revoked must not silence the rest of the machine.
      await syncOtherRoots();

      if (null === cloud.config) return undefined;
      const report = await pushRoot(deps.reticleRoot, cloud, force);
      // `pushRoot` returns undefined only for an unlinked root, which the guard above has ruled out.
      if (report === undefined) return undefined;
      // Nothing changed locally: no call was made, and the next look is one interval away.
      if (null === report) {
        nextDelay = intervalMs;
        return undefined;
      }
      // Said out loud on EVERY cycle, including the ones that moved nothing and the ones that
      // failed. The log below is deliberately quiet when idle, which is right for a log and wrong
      // for a hook: from outside, "nothing changed" and "sync has been broken since Tuesday" are
      // the same silence, and a consumer that cannot tell them apart has to guess.
      /*
       * `ok`, not "no transport error": a push the server refused completed its HTTP exchange and
       * still left the dashboard without the thing. The refusal's reason rides as the error.
       */
      const failure = report.error ?? (report.ok ? undefined : describeSync(report));
      emitSyncHook({
        runsPushed: report.runsSent,
        ok: report.ok,
        ...(failure === undefined ? {} : { error: failure }),
      });
      if (failure !== undefined && failure !== reportedError) {
        reportedError = failure;
        log('reticle_cloud_sync_failed', { error: failure });
      }
      if (report.error !== undefined && !AUTH_REFUSED.test(report.error)) {
        // A network failure: wait longer each time, with jitter, so a machine offline for an hour
        // makes a few calls rather than one per interval.
        failures += 1;
        nextDelay = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures) * (0.5 + random() / 2);
      }
      if (report.error === undefined) {
        failures = 0;
        if (report.ok) lastPushAt = now();
        if (failure === undefined) reportedError = undefined;
        // Only when something actually moved. A per-minute "nothing to send" is noise that trains
        // people to stop reading the log.
        const moved = movedAnything(report);
        if (moved && failure === undefined)
          log('reticle_cloud_synced', { summary: describeSync(report) });
        /*
         * A cycle that moved something means a drive is in progress, so the next one comes sooner;
         * one that moved nothing means the machine is idle, so it backs straight off. The rate
         * follows the work without needing to be told about sessions, and an idle laptop settles at
         * the same cost it had before this existed.
         */
        nextDelay = moved ? activeIntervalMs : intervalMs;
      }
      return report;
    } catch (error: unknown) {
      // Belt and braces: runSyncCycle already swallows, and a throw here would kill the timer.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== reportedError) {
        reportedError = message;
        log('reticle_cloud_sync_failed', { error: message });
      }
      return undefined;
    } finally {
      await refreshUnsynced().catch(() => undefined);
      running = false;
    }
  };

  /** The delay for the NEXT cycle: fast while the last one moved something, slow once it stops. */
  let nextDelay = intervalMs;

  const schedule = (delay: number): void => {
    if (stopped) return;
    // Replace, never stack. `nudge` and the interval both schedule, and leaving the old timer armed
    // would let every nudge add a permanent extra cycle per minute for the life of the process.
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void cycle().finally(() => schedule(nextDelay));
    }, delay);
    // Unref'd: a pending sync must never be the reason a process refuses to exit.
    timer.unref?.();
  };

  schedule(FIRST_CYCLE_DELAY_MS);
  // A nudge, not an immediate cycle: the link file and its key are written one after the other.
  const unwatch = deps.watchLink?.(() => schedule(NUDGE_DELAY_MS));

  return {
    // A sync somebody asked for writes what is held on a timer first: a drive's run waits a few
    // seconds after its last verdict, and a push straight after `session end` sent "0 of 0".
    syncNow: async () => {
      await flushPendingWrites();
      return cycle(true);
    },
    unsyncedRoots: () => unsynced,
    background: (): BackgroundSyncReport => {
      const gate = gates.get(deps.reticleRoot);
      return {
        state: gate?.state ?? BackgroundSyncState.ON,
        why: gate?.why ?? 'not checked yet',
        failures,
        ...(reportedError === undefined ? {} : { lastError: reportedError }),
        ...(lastPushAt === undefined ? {} : { lastPushAt }),
      };
    },
    nudge: (): void => {
      // A cycle already in flight will not pick this up, so the nudge is still scheduled behind it
      // rather than dropped — otherwise the run that arrived during a slow cycle waits a full tick.
      schedule(NUDGE_DELAY_MS);
    },
    stop: (): void => {
      unwatch?.();
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    flush: async (): Promise<void> => {
      unwatch?.();
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // A cycle already running may have started BEFORE the write being flushed, so its report says
      // nothing about that artifact. Wait it out rather than skipping on the overlap guard.
      const deadline = Date.now() + FLUSH_WAIT_MS;
      while (running && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_MS));
      await cycle(true);
    },
  };
}

/**
 * Start cloud sync for a daemon and hand back the two hooks the daemon wires to it.
 *
 * The wiring lived in `index.ts`, which sits exactly on the thousand-line cap — so the next thing
 * anyone needed there could not be added without a split, and this is the block that most obviously
 * did not belong in a bootstrap file. Four calls that are all one concern: what to sync, where else
 * to look, how a landed run wakes it, and what the panel's button does.
 *
 * Returns the daemon itself: the caller still owns when to nudge, when to sync now, and when to
 * stop. Only the CONSTRUCTION moved, which is the part that was four interdependent arguments about
 * resolving a credential — and the part a bootstrap file has no business spelling out.
 */
export function attachCloudSync(deps: {
  fs: FileSystemPort;
  reticleRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  otherRoots: () => readonly string[];
  /** The signed-in session's token for a platform address, or undefined. See `signedInTo`. */
  signedIn: (url: string) => string | undefined;
  /** Injected for the tests. */
  request?: SyncDaemonDeps['request'];
  intervalMs?: number;
}): SyncDaemon {
  return startSyncDaemon({
    reticleRoot: deps.reticleRoot,
    cloud: () => resolveProjectCloud(deps.fs, deps.reticleRoot, deps.homeDir, deps.env),
    // Every OTHER linked repo on this machine, not just the directory the daemon was started in.
    // One daemon serves many projects, and pushing only its own root left the rest silently
    // reporting nothing — indistinguishable, on the dashboard, from nobody having verified anything.
    otherRoots: () => Promise.resolve(deps.otherRoots()),
    cloudFor: (root) => resolveProjectCloud(deps.fs, root, deps.homeDir, deps.env),
    // ponytail: this root only; a sibling root's re-link is still read on the next tick.
    watchLink: (onChange) => watchLinkFile(deps.reticleRoot, onChange),
    // Sent only while somebody is signed in, to a linked project that did not switch it off.
    gate: (root, cloud) =>
      backgroundSyncGate({ reticleRoot: root, cloud, env: deps.env, signedIn: deps.signedIn }),
    fingerprint: localFingerprint,
    random: Math.random,
    ...(deps.request === undefined ? {} : { request: deps.request }),
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),
  });
}

/** Watch a root for its link file changing. A root with no `.reticle` yet is picked up per tick. */
function watchLinkFile(reticleRoot: string, onChange: () => void): () => void {
  try {
    const watcher = watch(reticleRoot, (_event, name) => {
      if (CLOUD_LINK_FILE === String(name)) onChange();
    });
    watcher.on('error', () => watcher.close());
    watcher.unref();
    return () => watcher.close();
  } catch {
    return () => undefined;
  }
}
