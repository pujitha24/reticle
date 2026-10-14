/**
 * The user's request as Reticle keeps it: redacted, split into statements, classified, and marked
 * shared or not. Two writers use it. `reticle_intent { declare, request }` records what the agent
 * relays, and `reticle hook prompt` records what the user typed, before the agent sees it. One
 * function, so the two writers cannot keep the request in two shapes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  StatementSource,
  classifyStatement,
  splitStatements,
  type PromptContext,
} from '@reticlehq/core/artifacts';
import { ReticleDir, apiKeyFrom, mainCheckoutTwin } from '@reticlehq/core';
import { readTextOrUndefined } from '@/memory/project/fs/fs-port.js';
import { redactFeedbackText } from '@/telemetry/feedback.js';

export const MAX_REQUEST = 20_000;
const MAX_STATEMENT = 500;
const MAX_STATEMENTS = 100;
export const PROJECT_CONFIG = '.reticle.json';

/** Credentials and personal data out, length capped: the same rules feedback reports follow. */
export function redactSecrets(text: string, max: number): string {
  return redactFeedbackText(text, max).text;
}

/** One setting from the project's `.reticle.json`, or undefined when it is absent or unreadable. */
export function projectSetting(projectDir: string, key: string): unknown {
  try {
    const config: unknown = JSON.parse(readFileSync(join(projectDir, PROJECT_CONFIG), 'utf8'));
    return 'object' === typeof config && null !== config
      ? (config as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the request goes to the platform with the runs that verify it.
 *
 * A LINKED project shares it unless `.reticle.json` says `"shareRequests": false`: the platform
 * reads what each run was for, which is half of what a run means. An unlinked project has nowhere
 * to send it, and `"shareRequests": true` still shares from one that links later.
 */
export function sharesRequests(projectDir: string, reticleRoot: string): boolean {
  const setting = projectSetting(projectDir, 'shareRequests');
  if (false === setting) return false;
  if (true === setting) return true;
  // Linked by `reticle connect` (cloud.json), or by a key in the environment, the way CI syncs.
  return (
    existsSync(join(reticleRoot, ReticleDir.CLOUD_LINK_FILE)) ||
    // A git worktree of a linked project is linked: its `.reticle/` is often git-ignored.
    existsSync(
      join(
        mainCheckoutTwin(reticleRoot, readTextOrUndefined) ?? reticleRoot,
        ReticleDir.CLOUD_LINK_FILE,
      ),
    ) ||
    apiKeyFrom(process.env) !== undefined
  );
}

/**
 * The prompt context for one request. `agentStatements` are the statements the agent declared
 * beside it; the hook has none. Pure: the clock and the share decision arrive as values.
 */
export function promptContextFor(
  request: string,
  agentStatements: readonly string[],
  at: number,
  shared: boolean,
): PromptContext {
  const text = redactSecrets(request, MAX_REQUEST);
  return {
    request: text,
    statements: [
      ...splitStatements(text).map((t) => ({ text: t, source: StatementSource.USER })),
      ...agentStatements.map((t) => ({
        text: redactSecrets(t, MAX_STATEMENT),
        source: StatementSource.AGENT,
      })),
    ]
      .slice(0, MAX_STATEMENTS)
      .map((s) => ({
        ...s,
        text: s.text.slice(0, MAX_STATEMENT),
        kind: classifyStatement(s.text),
      })),
    at,
    shared,
  };
}
