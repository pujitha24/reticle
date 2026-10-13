import { describe, expect, it } from 'vitest';
import type { Checkout } from '@reticlehq/core';
import { scopeToCallerCheckout } from './session-manager.js';

const MAIN: Checkout = { root: '/repo', mainRoot: '/repo', branch: 'main', linked: false };
const WT_A: Checkout = { root: '/wt/a', mainRoot: '/repo', branch: 'feat/a', linked: true };
const WT_B: Checkout = { root: '/wt/b', mainRoot: '/repo', branch: 'feat/b', linked: true };

const tab = (id: string, url: string) => ({ id, url });
const servedBy: Record<string, Checkout> = {
  'http://localhost:5173/': MAIN,
  'http://localhost:5174/': WT_A,
  'http://localhost:5175/': WT_B,
};
const checkoutOfUrl = (url: string): Checkout | undefined => servedBy[url];

describe('scopeToCallerCheckout', () => {
  /** Two agents, two worktrees, one app: each must land on its own tab, never the other's. */
  it('keeps only the tabs served from the agent’s own worktree', () => {
    const tabs = [tab('s-main', 'http://localhost:5173/'), tab('s-a', 'http://localhost:5174/')];
    expect(scopeToCallerCheckout(tabs, WT_A, checkoutOfUrl).sessions.map((s) => s.id)).toEqual([
      's-a',
    ]);
    expect(scopeToCallerCheckout(tabs, MAIN, checkoutOfUrl).sessions.map((s) => s.id)).toEqual([
      's-main',
    ]);
  });

  /** The tab of another worktree runs other code: a verdict on it is about code the agent never touched. */
  it('refuses when every tab is served from another worktree, and names them', () => {
    const result = scopeToCallerCheckout(
      [tab('s-b', 'http://localhost:5175/')],
      WT_A,
      checkoutOfUrl,
    );
    expect(result.sessions).toEqual([]);
    expect(result.refusal).toContain('/wt/b');
    expect(result.refusal).toContain('feat/b');
    expect(result.refusal).toContain('s-b');
    expect(result.refusal).toContain('/wt/a');
  });

  it('keeps every tab when a tab’s checkout cannot be read', () => {
    const tabs = [tab('s-b', 'http://localhost:5175/'), tab('s-x', 'http://localhost:9999/')];
    expect(scopeToCallerCheckout(tabs, WT_A, checkoutOfUrl)).toEqual({ sessions: tabs });
  });

  it('keeps every tab when the agent is outside git', () => {
    const tabs = [tab('s-b', 'http://localhost:5175/')];
    expect(scopeToCallerCheckout(tabs, undefined, checkoutOfUrl)).toEqual({ sessions: tabs });
  });

  it('keeps every tab of a different repository', () => {
    const other: Checkout = { root: '/elsewhere', mainRoot: '/elsewhere', linked: false };
    const tabs = [tab('s-b', 'http://localhost:5175/')];
    expect(scopeToCallerCheckout(tabs, other, checkoutOfUrl)).toEqual({ sessions: tabs });
  });
});
