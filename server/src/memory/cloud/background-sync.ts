/**
 * Whether the daemon's background sync may send a project's work, and whether there is work to send.
 *
 * The daemon sends without anybody asking, so it sends only when every one of these holds:
 *
 * - Nobody switched it off: `RETICLE_BACKGROUND_SYNC=0` on the machine, `"backgroundSync": false`
 *   in the project's `.reticle.json`.
 * - The project is LINKED, by its own `.reticle/cloud.json`. The address comes from that link and
 *   nowhere else. An environment address is never used: a repository's `.env` that named the
 *   hosted service once sent another app's runs to the wrong workspace.
 * - Somebody is signed in to that address, and this machine holds a key for the link. `reticle
 *   logout` stops it on the next tick; `reticle login` starts it again.
 *
 * `reticle sync` stays the explicit way to send now, and none of this applies to it.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ReticleDir, ReticleEnv } from '@reticlehq/core';
import { projectSetting } from '@/memory/intent/record-request.js';
import { DERIVED_RECORDS } from './sync-cycle.js';
import type { ProjectCloud } from './cloud-config.js';

export const BackgroundSyncState = {
  ON: 'on',
  OPTED_OUT: 'opted-out',
  UNLINKED: 'unlinked',
  SIGNED_OUT: 'signed-out',
  /** The platform refused the credential (401/403). Stays stopped until the sign-in changes. */
  REFUSED: 'refused',
} as const;
export type BackgroundSyncState = (typeof BackgroundSyncState)[keyof typeof BackgroundSyncState];

export interface BackgroundSyncGate {
  state: BackgroundSyncState;
  /** In words a person can act on. */
  why: string;
  /** Who is sending, when it is ON: a new value after a new sign-in or a new key. */
  credential?: string;
}

const OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);
const BACKGROUND_SYNC_SETTING = 'backgroundSync';

/** May the daemon send this root's work now? Reads the disk, never the network. */
export function backgroundSyncGate(input: {
  reticleRoot: string;
  cloud: ProjectCloud;
  env: NodeJS.ProcessEnv;
  /** The signed-in session's token for that address, or undefined. */
  signedIn: (url: string) => string | undefined;
}): BackgroundSyncGate {
  const { reticleRoot, cloud, env, signedIn } = input;
  if (OFF_VALUES.has((env[ReticleEnv.BACKGROUND_SYNC] ?? '').toLowerCase())) {
    return {
      state: BackgroundSyncState.OPTED_OUT,
      why: `off on this machine (${ReticleEnv.BACKGROUND_SYNC})`,
    };
  }
  if (false === projectSetting(dirname(reticleRoot), BACKGROUND_SYNC_SETTING)) {
    return {
      state: BackgroundSyncState.OPTED_OUT,
      why: `off in this project ("${BACKGROUND_SYNC_SETTING}": false in .reticle.json)`,
    };
  }
  // `link` is set only from the project's own link file; an environment key leaves it unset.
  if (cloud.link === undefined) {
    return {
      state: BackgroundSyncState.UNLINKED,
      why: 'this project is not linked: run `reticle connect`',
    };
  }
  if (null === cloud.config) {
    return {
      state: BackgroundSyncState.SIGNED_OUT,
      why: cloud.reason ?? 'no key for this link: run `reticle connect`',
    };
  }
  const token = signedIn(cloud.config.url);
  if (token === undefined) {
    return {
      state: BackgroundSyncState.SIGNED_OUT,
      why: `nobody is signed in to ${cloud.config.url}: run \`reticle login --url ${cloud.config.url}\``,
    };
  }
  return {
    state: BackgroundSyncState.ON,
    why: `sends to ${cloud.config.url}`,
    credential: `${cloud.config.apiKey}\u0000${token}`,
  };
}

/** Every file and folder a cycle reads, relative to the `.reticle` root. One level down is read too. */
const SYNCED_PATHS: readonly string[] = [
  ReticleDir.RUNS_SUBDIR,
  ReticleDir.FLOWS_SUBDIR,
  ReticleDir.CAPSULES_SUBDIR,
  ReticleDir.INTENT_SUBDIR,
  ReticleDir.REQUEST_FILE,
  ReticleDir.REQUESTS_LOG_FILE,
  ReticleDir.CLOUD_LINK_FILE,
  ...DERIVED_RECORDS.map((record) => record.file),
];

/**
 * A cheap summary of everything a cycle would send: name, size and modified time of each synced file.
 * The same value twice means nothing changed, so the tick makes no network call. The content hash
 * that decides WHAT to send stays in the cycle, which compares it with what the platform holds.
 */
export function localFingerprint(reticleRoot: string): string {
  const parts: string[] = [];
  const stamp = (path: string, depth: number): void => {
    try {
      const stat = statSync(path);
      parts.push(`${path}:${String(stat.size)}:${String(stat.mtimeMs)}`);
      if (!stat.isDirectory() || 0 === depth) return;
      for (const name of readdirSync(path).sort()) stamp(join(path, name), depth - 1);
    } catch {
      parts.push(`${path}:absent`);
    }
  };
  for (const rel of SYNCED_PATHS) stamp(join(reticleRoot, rel), 2);
  return parts.join('\n');
}
