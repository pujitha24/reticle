/**
 * The prompt-capture hook, in the config of each agent that runs a command when a prompt is sent.
 *
 * The user's request is what a verdict is checked against. An agent relays it with
 * `reticle_intent { declare, request }` only when it remembers to, so the agents that have a
 * prompt-submit hook hand it over themselves: the hook runs `reticle hook prompt`, which writes the
 * prompt into the project's `.reticle/`.
 *
 * Every event name, path and shape here comes from the vendor's documentation, read on 2026-10-14
 * (the `docs` field names the page). The configs are PROJECT-level, so the capture follows the
 * repository. An agent with no prompt hook, or one whose hook format is not documented well enough
 * to write, is not here: it relies on the MCP instructions, which tell the agent to declare the
 * request. A config at a guessed path is one nobody reads, and that looks the same as success.
 *
 * The merge is JSON only, and it never rewrites a file that is not a plain JSON object (comments,
 * trailing commas): the caller prints the entry instead.
 */
import { RETICLE_NPM_PACKAGE } from '@/version.js';

export const PromptHookAgent = {
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
  CODEX: 'codex',
  GEMINI: 'gemini',
  WINDSURF: 'windsurf',
  /** VS Code agent mode and Copilot CLI: both read `.github/hooks/*.json`. */
  COPILOT: 'copilot',
  FACTORY: 'factory-droid',
} as const;
export type PromptHookAgent = (typeof PromptHookAgent)[keyof typeof PromptHookAgent];

export const PromptHookStatus = {
  APPLY: 'apply',
  ALREADY: 'already',
  MANUAL: 'manual',
} as const;
export type PromptHookStatus = (typeof PromptHookStatus)[keyof typeof PromptHookStatus];

/** The words every one of our commands holds, and no other command does. */
export const PROMPT_HOOK_MARKER = `${RETICLE_NPM_PACKAGE} hook prompt`;
export const AGENT_FLAG = '--agent';
/** Seconds. The hook finishes in well under one; this only bounds a hung `npx`. */
const HOOK_TIMEOUT_S = 10;

export const promptHookCommand = (agent: PromptHookAgent): string =>
  `npx ${PROMPT_HOOK_MARKER} ${AGENT_FLAG} ${agent}`;

/** One place in the config that holds a list of hook entries, and the entry we add to it. */
interface HookSlot {
  /** Keys from the top of the file down to the list. */
  readonly path: readonly string[];
  readonly entry: (command: string) => Record<string, unknown>;
}

export interface PromptHookSpec {
  readonly id: PromptHookAgent;
  readonly label: string;
  /** Project-relative configs this agent reads, first wins. We write to the first that exists. */
  readonly paths: readonly string[];
  /** Written when none of `paths` exists. */
  readonly defaultPath: string;
  /** Keys we add at the top of a NEW file, and remove again when the file holds nothing else. */
  readonly header?: Readonly<Record<string, unknown>>;
  readonly slots: readonly HookSlot[];
  /** Project-relative directories that show the agent is used here. */
  readonly projectMarkers: readonly string[];
  /** Home-relative directories that show the agent is on this machine. */
  readonly homeMarkers: readonly string[];
  readonly docs: string;
}

/** `{ hooks: [{ type, command, timeout }] }`: Claude Code's group shape, which Codex and Factory copy. */
const group = (command: string): Record<string, unknown> => ({
  hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }],
});

export const PROMPT_HOOK_AGENTS: readonly PromptHookSpec[] = [
  {
    id: PromptHookAgent.CLAUDE_CODE,
    label: 'Claude Code',
    paths: ['.claude/settings.json'],
    defaultPath: '.claude/settings.json',
    slots: [{ path: ['hooks', 'UserPromptSubmit'], entry: group }],
    projectMarkers: ['.claude'],
    homeMarkers: ['.claude'],
    docs: 'https://code.claude.com/docs/en/hooks',
  },
  {
    id: PromptHookAgent.CURSOR,
    label: 'Cursor',
    paths: ['.cursor/hooks.json'],
    defaultPath: '.cursor/hooks.json',
    header: { version: 1 },
    slots: [{ path: ['hooks', 'beforeSubmitPrompt'], entry: (command) => ({ command }) }],
    projectMarkers: ['.cursor'],
    homeMarkers: ['.cursor'],
    docs: 'https://cursor.com/docs/agent/hooks',
  },
  {
    id: PromptHookAgent.CODEX,
    label: 'Codex CLI',
    paths: ['.codex/hooks.json'],
    defaultPath: '.codex/hooks.json',
    slots: [{ path: ['hooks', 'UserPromptSubmit'], entry: group }],
    projectMarkers: ['.codex'],
    homeMarkers: ['.codex'],
    docs: 'https://learn.chatgpt.com/docs/hooks',
  },
  {
    id: PromptHookAgent.GEMINI,
    label: 'Gemini CLI',
    paths: ['.gemini/settings.json'],
    defaultPath: '.gemini/settings.json',
    // No timeout: the docs do not settle its unit.
    slots: [
      {
        path: ['hooks', 'BeforeAgent'],
        entry: (command) => ({ matcher: '*', hooks: [{ type: 'command', command }] }),
      },
    ],
    projectMarkers: ['.gemini'],
    // The settings FILE: Antigravity shares `~/.gemini` and has no prompt hook.
    homeMarkers: ['.gemini/settings.json'],
    docs: 'https://geminicli.com/docs/hooks/reference/',
  },
  {
    id: PromptHookAgent.WINDSURF,
    label: 'Windsurf',
    // The current layout first; the legacy file is read when the current one is absent.
    paths: ['.devin/hooks.json', '.windsurf/hooks.json'],
    defaultPath: '.windsurf/hooks.json',
    slots: [{ path: ['hooks', 'pre_user_prompt'], entry: (command) => ({ command }) }],
    projectMarkers: ['.windsurf', '.devin'],
    homeMarkers: ['.codeium/windsurf'],
    docs: 'https://docs.devin.ai/desktop/cascade/hooks.md',
  },
  {
    id: PromptHookAgent.COPILOT,
    label: 'VS Code Copilot and Copilot CLI',
    // A file of our own, so uninstall can remove it whole.
    paths: ['.github/hooks/reticle-prompt-capture.json'],
    defaultPath: '.github/hooks/reticle-prompt-capture.json',
    header: { version: 1 },
    slots: [
      {
        path: ['hooks', 'UserPromptSubmit'],
        entry: (command) => ({ type: 'command', command, timeout: HOOK_TIMEOUT_S }),
      },
      {
        path: ['hooks', 'userPromptSubmitted'],
        entry: (command) => ({
          type: 'command',
          bash: command,
          powershell: command,
          timeoutSec: HOOK_TIMEOUT_S,
        }),
      },
    ],
    projectMarkers: ['.github/hooks', '.vscode'],
    homeMarkers: ['.copilot', '.vscode'],
    docs: 'https://code.visualstudio.com/docs/copilot/customization/hooks and https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference',
  },
  {
    id: PromptHookAgent.FACTORY,
    label: 'Factory Droid',
    paths: ['.factory/hooks.json'],
    defaultPath: '.factory/hooks.json',
    // The events sit at the top of this file, with no `hooks` key around them.
    slots: [{ path: ['UserPromptSubmit'], entry: group }],
    projectMarkers: ['.factory'],
    homeMarkers: ['.factory'],
    docs: 'https://docs.factory.com/reference/hooks-reference.md',
  },
];

/**
 * The agents with no prompt hook that can be written, which therefore rely on the MCP instructions
 * telling the agent to declare the request. Each one was checked on 2026-10-14: no prompt-submit
 * event, or one whose config format the vendor does not document well enough to write.
 */
export const MCP_FALLBACK_AGENTS: readonly string[] = [
  'Claude Desktop (chat)',
  'Cursor CLI in -p mode',
  'Codex IDE extension',
  'OpenCode',
  'Antigravity',
  'Zed',
  'Warp',
  'Kiro',
  'Amazon Q Developer CLI',
  'Cline',
  'Roo Code',
  'Continue',
  'Amp',
];

/** One agent found here: its spec, its config's absolute path, and what that file holds now. */
export interface PromptHookTarget {
  readonly spec: PromptHookSpec;
  readonly path: string;
  readonly existing: string | null;
}

/**
 * The agents used in `projectDir` or installed under `home`, each with the config to write.
 *
 * Only those: a `.gemini/settings.json` in the repository of somebody who has never run Gemini is
 * litter, and it makes the next tool's detection wrong too. `claudeCli` counts Claude Code as
 * present, because it keeps its registration behind its CLI rather than in a folder.
 */
export function promptHookTargets(
  io: { exists(path: string): boolean; readFile(path: string): string | null },
  projectDir: string,
  home: string,
  claudeCli: boolean,
  join: (...parts: string[]) => string,
): PromptHookTarget[] {
  const inProject = (rel: string): string => join(projectDir, rel);
  return PROMPT_HOOK_AGENTS.flatMap((spec) => {
    const used =
      (PromptHookAgent.CLAUDE_CODE === spec.id && claudeCli) ||
      spec.projectMarkers.some((marker) => io.exists(inProject(marker))) ||
      spec.homeMarkers.some((marker) => io.exists(join(home, marker)));
    if (!used) return [];
    const path = inProject(promptHookPath(spec, (rel) => io.exists(inProject(rel))));
    return [{ spec, path, existing: io.readFile(path) }];
  });
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);

/** The config as an object, or undefined when the text is not one. Empty text is an empty config. */
function parseConfig(text: string | null): Json | undefined {
  if (null === text || 0 === text.trim().length) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const serialize = (config: Json): string => `${JSON.stringify(config, null, 2)}\n`;

const ours = (item: unknown): boolean => JSON.stringify(item).includes(PROMPT_HOOK_MARKER);

/** The list at `path`, or an empty one. */
function listAt(config: Json, path: readonly string[]): unknown[] {
  let node: unknown = config;
  for (const key of path) node = isObject(node) ? node[key] : undefined;
  return Array.isArray(node) ? node : [];
}

/** A copy of `config` with the list at `path` replaced, or its key removed when the list is empty. */
function withList(config: Json, path: readonly string[], list: unknown[]): Json {
  const [key, ...rest] = path;
  if (key === undefined) return config;
  if (0 === rest.length) {
    const { [key]: _dropped, ...others } = config;
    return 0 === list.length ? others : { ...config, [key]: list };
  }
  const child = isObject(config[key]) ? config[key] : {};
  const next = withList(child, rest, list);
  if (0 < Object.keys(next).length) return { ...config, [key]: next };
  const { [key]: _gone, ...others } = config;
  return others;
}

/** The project-relative config to write, given which files exist. */
export function promptHookPath(spec: PromptHookSpec, exists: (path: string) => boolean): string {
  return spec.paths.find((path) => exists(path)) ?? spec.defaultPath;
}

export function promptHookInstalled(spec: PromptHookSpec, text: string | null): boolean {
  const config = parseConfig(text);
  return (
    config !== undefined &&
    spec.slots.every((slot) => listAt(config, slot.path).some((item) => ours(item)))
  );
}

/** Our entry merged into the config. `content` is the text to write; MANUAL keeps the text as it is. */
export function installPromptHook(
  spec: PromptHookSpec,
  text: string | null,
): { status: PromptHookStatus; content: string } {
  const config = parseConfig(text);
  if (config === undefined) return { status: PromptHookStatus.MANUAL, content: text ?? '' };
  if (promptHookInstalled(spec, text)) {
    return { status: PromptHookStatus.ALREADY, content: text ?? '' };
  }
  const command = promptHookCommand(spec.id);
  let next: Json = { ...(spec.header ?? {}), ...config };
  for (const slot of spec.slots) {
    const list = listAt(next, slot.path).filter((item) => !ours(item));
    next = withList(next, slot.path, [...list, slot.entry(command)]);
  }
  return { status: PromptHookStatus.APPLY, content: serialize(next) };
}

/**
 * The config with our entries removed. `content` null means delete the file: it holds nothing but
 * what install added. A config that is not ours to parse is never changed.
 */
export function uninstallPromptHook(
  spec: PromptHookSpec,
  text: string | null,
): { changed: boolean; content: string | null } {
  const config = parseConfig(text);
  if (null === text || config === undefined) return { changed: false, content: text };
  let next = config;
  let changed = false;
  for (const slot of spec.slots) {
    const list = listAt(next, slot.path);
    const kept = list.filter((item) => !ours(item));
    if (kept.length === list.length) continue;
    changed = true;
    next = withList(next, slot.path, kept);
  }
  if (!changed) return { changed: false, content: text };
  const header = spec.header ?? {};
  const onlyHeader = Object.keys(next).every(
    (key) => JSON.stringify(next[key]) === JSON.stringify(header[key]),
  );
  return { changed: true, content: onlyHeader ? null : serialize(next) };
}
