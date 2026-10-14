import { describe, expect, it } from 'vitest';
import {
  PROMPT_HOOK_AGENTS,
  PromptHookAgent,
  PromptHookStatus,
  installPromptHook,
  promptHookCommand,
  promptHookInstalled,
  promptHookPath,
  uninstallPromptHook,
} from './prompt-hooks.js';
import { RETICLE_VERSION } from '@/version.js';

/** The value at a path of keys and indexes in parsed JSON, or undefined. */
const dig = (text: string, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (node, key) =>
      'object' === typeof node && null !== node
        ? (node as Record<string, unknown>)[key]
        : undefined,
    JSON.parse(text) as unknown,
  );

const spec = (id: string) => {
  const found = PROMPT_HOOK_AGENTS.find((a) => a.id === id);
  if (found === undefined) throw new Error(`no spec for ${id}`);
  return found;
};

describe('the prompt-capture hook in each agent config', () => {
  it('writes each agent its documented shape', () => {
    const content = (id: string): string => installPromptHook(spec(id), null).content;
    expect(
      dig(content(PromptHookAgent.CLAUDE_CODE), 'hooks', 'UserPromptSubmit', 0, 'hooks', 0),
    ).toMatchObject({ type: 'command', command: promptHookCommand(PromptHookAgent.CLAUDE_CODE) });
    expect(JSON.parse(content(PromptHookAgent.CURSOR)) as unknown).toEqual({
      version: 1,
      hooks: { beforeSubmitPrompt: [{ command: promptHookCommand(PromptHookAgent.CURSOR) }] },
    });
    expect(
      dig(content(PromptHookAgent.GEMINI), 'hooks', 'BeforeAgent', 0, 'hooks', 0, 'command'),
    ).toBe(promptHookCommand(PromptHookAgent.GEMINI));
    // Factory's hooks file holds the events at the top, with no `hooks` wrapper.
    expect(
      dig(content(PromptHookAgent.FACTORY), 'UserPromptSubmit', 0, 'hooks', 0, 'command'),
    ).toBe(promptHookCommand(PromptHookAgent.FACTORY));
    expect(dig(content(PromptHookAgent.WINDSURF), 'hooks', 'pre_user_prompt', 0, 'command')).toBe(
      promptHookCommand(PromptHookAgent.WINDSURF),
    );
    // One file for both: VS Code reads `UserPromptSubmit`, Copilot CLI reads `userPromptSubmitted`.
    const copilot = content(PromptHookAgent.COPILOT);
    expect(dig(copilot, 'hooks', 'UserPromptSubmit', 0, 'command')).toBe(
      promptHookCommand(PromptHookAgent.COPILOT),
    );
    expect(dig(copilot, 'hooks', 'userPromptSubmitted', 0, 'bash')).toBe(
      promptHookCommand(PromptHookAgent.COPILOT),
    );
  });

  it('keeps the hooks and settings that are already there', () => {
    const existing = JSON.stringify({
      model: 'x',
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }],
      },
    });
    const out = installPromptHook(spec(PromptHookAgent.CLAUDE_CODE), existing);
    expect(out.status).toBe(PromptHookStatus.APPLY);
    expect(dig(out.content, 'model')).toBe('x');
    expect(dig(out.content, 'hooks', 'Stop')).toHaveLength(1);
    expect(dig(out.content, 'hooks', 'UserPromptSubmit')).toHaveLength(2);
    expect(dig(out.content, 'hooks', 'UserPromptSubmit', 0, 'hooks', 0, 'command')).toBe(
      'theirs.sh',
    );
  });

  it('adds nothing on a second run', () => {
    for (const agent of PROMPT_HOOK_AGENTS) {
      const once = installPromptHook(agent, null).content;
      const twice = installPromptHook(agent, once);
      expect(twice.status, agent.id).toBe(PromptHookStatus.ALREADY);
      expect(twice.content, agent.id).toBe(once);
      expect(promptHookInstalled(agent, once), agent.id).toBe(true);
    }
  });

  it('names the version that installed it, so a stale npx cache cannot run an older CLI', () => {
    expect(promptHookCommand(PromptHookAgent.CURSOR)).toBe(
      `npx -y @reticlehq/server@${RETICLE_VERSION} hook prompt --agent cursor`,
    );
  });

  it('replaces an entry an older version wrote, and keeps one', () => {
    const old = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'npx -y @reticlehq/server@0.0.1 hook prompt --agent claude-code',
              },
            ],
          },
          { hooks: [{ type: 'command', command: 'theirs.sh' }] },
        ],
      },
    });
    const claude = spec(PromptHookAgent.CLAUDE_CODE);
    expect(promptHookInstalled(claude, old)).toBe(false);
    const out = installPromptHook(claude, old);
    expect(out.status).toBe(PromptHookStatus.APPLY);
    const commands = JSON.stringify(dig(out.content, 'hooks', 'UserPromptSubmit'));
    expect(commands).not.toContain('@0.0.1');
    expect(commands).toContain('theirs.sh');
    expect(commands.split(promptHookCommand(PromptHookAgent.CLAUDE_CODE))).toHaveLength(2);
  });

  it('leaves a file that is not a JSON object alone', () => {
    const out = installPromptHook(spec(PromptHookAgent.GEMINI), '{ // comments\n}');
    expect(out.status).toBe(PromptHookStatus.MANUAL);
    expect(out.content).toBe('{ // comments\n}');
  });

  it('removes only its own entry on uninstall', () => {
    const theirs = { hooks: [{ type: 'command', command: 'theirs.sh' }] };
    const existing = JSON.stringify({ model: 'x', hooks: { UserPromptSubmit: [theirs] } });
    const installed = installPromptHook(spec(PromptHookAgent.CLAUDE_CODE), existing).content;
    const removed = uninstallPromptHook(spec(PromptHookAgent.CLAUDE_CODE), installed);
    expect(removed.changed).toBe(true);
    expect(JSON.parse(removed.content ?? '') as unknown).toEqual({
      model: 'x',
      hooks: { UserPromptSubmit: [theirs] },
    });
  });

  it('deletes a file it created and that holds nothing else', () => {
    for (const agent of PROMPT_HOOK_AGENTS) {
      const created = installPromptHook(agent, null).content;
      const removed = uninstallPromptHook(agent, created);
      expect(removed, agent.id).toEqual({ changed: true, content: null });
    }
  });

  it('changes nothing where it is not installed', () => {
    const existing = JSON.stringify({ hooks: { Stop: [] } });
    expect(uninstallPromptHook(spec(PromptHookAgent.CLAUDE_CODE), existing)).toEqual({
      changed: false,
      content: existing,
    });
    expect(uninstallPromptHook(spec(PromptHookAgent.CLAUDE_CODE), null).changed).toBe(false);
  });

  it('writes Windsurf where Windsurf reads first', () => {
    const windsurf = spec(PromptHookAgent.WINDSURF);
    expect(promptHookPath(windsurf, () => false)).toBe('.windsurf/hooks.json');
    expect(promptHookPath(windsurf, (p) => '.devin/hooks.json' === p)).toBe('.devin/hooks.json');
  });
});
