/**
 * Which directory the dev server that served a page runs in.
 *
 * The tie-breaker for a project several checkouts declare: every git worktree carries the same
 * committed `.reticle.json`, so the projectId cannot tell them apart, but the process serving the
 * page runs inside exactly one of them. Lives with the session rather than the artifact resolver
 * because both observations are about this machine's processes -- daemon state files and `lsof` --
 * which `memory/project` has no business knowing. The resolver takes the answer as an injected
 * function; the composition roots pass this one.
 */
import { type Checkout, type DevServerEntry, isLoopbackHostname } from '@reticlehq/core';
import { captureLookup, findListenerCwd } from '@/command/cli/ports/port-holder.js';
import { reticleStateHome } from '@/command/daemon/daemon.js';
import { readDevServers } from '@/command/daemon/dev-servers.js';
import { checkoutAt, hasLinkedWorktrees } from '@/command/cli/config/checkout.js';
import { callingClientDirectory } from '@/hooks/client-directory.js';
import { originOf, type CheckoutSource } from './session-manager.js';

/** Where `servingDirectoryOf` gets its two observations. Injected so a test needs no processes. */
export interface ServingDirectoryIo {
  /** Live dev servers that announced themselves (the Vite plugin writes `devserver-<port>.json`). */
  devServers: () => readonly DevServerEntry[];
  /** The working directory of whatever listens on `port`, or null when it cannot be read. */
  listenerCwd: (port: number) => string | null;
}

const DEFAULT_PORT: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

const liveIo: ServingDirectoryIo = {
  devServers: () => readDevServers(reticleStateHome()),
  listenerCwd: (port) => findListenerCwd(port, captureLookup),
};

/**
 * The directory of the dev server that served `origin`, or undefined when it cannot be observed.
 *
 * Two observations, exact one first. A dev server whose plugin announced this port names its own
 * root and works on every platform. Otherwise the process listening on the port is asked for its
 * working directory, which covers frameworks with no announcing plugin (Next.js) wherever `lsof`
 * runs. Loopback only: a remote page's port says nothing about any process on this machine.
 */
export function servingDirectoryOf(
  origin: string,
  io: ServingDirectoryIo = liveIo,
): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (!isLoopbackHostname(url.hostname)) return undefined;
  const port = '' === url.port ? DEFAULT_PORT[url.protocol] : Number(url.port);
  if (port === undefined) return undefined;
  const announced = io.devServers().find((entry) => entry.port === port);
  if (announced !== undefined) return announced.root;
  return io.listenerCwd(port) ?? undefined;
}

/**
 * The live answers for a worktree-scoped resolve: the calling agent's checkout (from the directory
 * its MCP proxy runs in) and each tab's checkout (from the dev server that served it).
 */
/** How long one origin's serving checkout is trusted. A dev server can restart in another worktree. */
const SERVING_TTL_MS = 30_000;

export function liveCheckoutSource(now: () => number = Date.now): CheckoutSource {
  const cache = new Map<string, { at: number; checkout: Checkout | undefined }>();
  return {
    caller: () => {
      const dir = callingClientDirectory();
      const checkout = dir === undefined ? undefined : checkoutAt(dir);
      // A repository with no linked worktree has nothing to tell apart: skip the serving lookups.
      return checkout !== undefined && hasLinkedWorktrees(checkout.mainRoot) ? checkout : undefined;
    },
    ofUrl: (url) => {
      const origin = originOf(url);
      if (origin === undefined) return undefined;
      const hit = cache.get(origin);
      if (hit !== undefined && now() - hit.at < SERVING_TTL_MS) return hit.checkout;
      const serving = servingDirectoryOf(origin);
      const checkout = serving === undefined ? undefined : checkoutAt(serving);
      cache.set(origin, { at: now(), checkout });
      return checkout;
    },
  };
}
