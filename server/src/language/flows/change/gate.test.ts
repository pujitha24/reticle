import { describe, expect, it } from 'vitest';
import { RunFlowStatus, type RunFlowResult } from '@reticlehq/core';
import { gateDecision, latestFlowResults, passingFlowNames } from './gate.js';

describe('gateDecision', () => {
  it('passes when every affected flow has a passing artifact', () => {
    const result = gateDecision({
      affected: ['checkout', 'login'],
      passing: ['checkout', 'login', 'search'],
    });
    expect(result.pass).toBe(true);
    expect(result.uncovered).toEqual([]);
  });

  it('blocks on an affected flow with no passing artifact', () => {
    const result = gateDecision({ affected: ['checkout', 'billing'], passing: ['checkout'] });
    expect(result.pass).toBe(false);
    expect(result.uncovered).toEqual(['billing']);
  });

  it('quarantines a flaky flow instead of blocking on it', () => {
    const result = gateDecision({ affected: ['checkout'], passing: [], flaky: ['checkout'] });
    expect(result.pass).toBe(true);
    expect(result.uncovered).toEqual([]);
    expect(result.quarantined).toEqual(['checkout']);
  });

  it('still blocks a non-flaky uncovered flow even when another is quarantined', () => {
    const result = gateDecision({
      affected: ['checkout', 'billing'],
      passing: [],
      flaky: ['checkout'],
    });
    expect(result.pass).toBe(false);
    expect(result.uncovered).toEqual(['billing']);
    expect(result.quarantined).toEqual(['checkout']);
  });
});

describe('gate — anti-reward-hacking: weakened or deleted coverage BLOCKS', () => {
  it('blocks when an affected flow weakened its assertions since the last passing run', () => {
    // The gaming vector: the flow "passes", but only because its mustHold dropped from a real
    // consequence (signal/net/state) to a fakeable presence check. A green bought that way must not pass.
    const r = gateDecision({
      affected: ['checkout'],
      passing: ['checkout'],
      downgraded: [{ flow: 'checkout', steps: [2] }],
    });
    expect(r.pass).toBe(false);
    expect(r.downgraded).toEqual([{ flow: 'checkout', steps: [2] }]);
    expect(r.uncovered).toEqual([]); // it IS covered — that is precisely why the downgrade must block
  });

  it('blocks when a flow covering a changed file was deleted rather than satisfied', () => {
    const r = gateDecision({ affected: [], passing: [], deleted: ['checkout'] });
    expect(r.pass).toBe(false);
    expect(r.deleted).toEqual(['checkout']);
  });

  it('a flaky flow is still quarantined (not the agent’s doing) while a downgrade still blocks', () => {
    const r = gateDecision({
      affected: ['flaky-one', 'checkout'],
      passing: ['checkout'],
      flaky: ['flaky-one'],
      downgraded: [{ flow: 'checkout', steps: [0] }],
    });
    expect(r.quarantined).toEqual(['flaky-one']);
    expect(r.pass).toBe(false);
  });

  it('stays green when nothing was weakened or deleted', () => {
    const r = gateDecision({ affected: ['checkout'], passing: ['checkout'] });
    expect(r.pass).toBe(true);
    expect(r.downgraded).toEqual([]);
    expect(r.deleted).toEqual([]);
  });
});

describe('gate — a changed interactive component no flow covers BLOCKS', () => {
  it('blocks and names the file, even when every affected flow passed', () => {
    const r = gateDecision({ affected: ['a'], passing: ['a'], unflowed: ['src/NewWizard.tsx'] });
    expect(r.pass).toBe(false);
    expect(r.unflowed).toEqual(['src/NewWizard.tsx']);
  });
});

describe('gate — coverage that fell, or changed code that never ran, BLOCKS', () => {
  it('blocks on a coverage level below its best', () => {
    const r = gateDecision({
      affected: [],
      passing: [],
      coverageRegressed: [{ level: 'branched', was: 100, now: 50 }],
    });
    expect(r.pass).toBe(false);
    expect(r.coverageRegressed).toHaveLength(1);
  });

  it('blocks on a changed file none of whose functions ever ran', () => {
    const r = gateDecision({ affected: [], passing: [], unexecuted: ['src/Refund.tsx'] });
    expect(r.pass).toBe(false);
    expect(r.unexecuted).toEqual(['src/Refund.tsx']);
  });
});

// #1321: a suite replays runtime copies of a template with fixture parameters and deletes them,
// so the copies' names match no saved flow and the gate counted nothing.
describe('what a run lets the gate count as passing', () => {
  const run = (over: Partial<RunFlowResult>): RunFlowResult => ({
    name: 'checkout--fixture-7',
    template: 'checkout',
    status: RunFlowStatus.PASS,
    steps: 3,
    durationMs: 10,
    stepResults: [{ step: 0, anchor: 'Pay', ok: true, consequence: 'net POST /orders' }],
    ...over,
  });

  it('credits the template for a strict pass that proved a consequence', () => {
    expect(passingFlowNames([run({})]).sort()).toEqual(['checkout', 'checkout--fixture-7']);
  });

  it('credits nothing to the template for a healed, failed, skipped or assertion-free copy', () => {
    for (const copy of [
      run({ status: RunFlowStatus.HEALED }),
      run({ status: RunFlowStatus.FAIL }),
      run({ status: RunFlowStatus.SKIPPED }),
      run({ stepResults: [{ step: 0, anchor: 'Pay', ok: true }] }),
    ]) {
      expect(passingFlowNames([copy])).not.toContain('checkout');
    }
  });
});

/**
 * The gate read only the newest run. A hand drive saves a run with no flow results when its session
 * ends, so a run written after a passing replay hid the replay and the gate failed.
 */
describe('the flow results the gate reads', () => {
  const result = (name: string, status: RunFlowStatus): RunFlowResult => ({
    name,
    status,
    steps: 1,
    durationMs: 1,
  });

  it('takes the newest result of each flow from any run', () => {
    const runs = [
      { createdAt: 3, flows: [] },
      { createdAt: 2, flows: [result('checkout', RunFlowStatus.PASS)] },
      {
        createdAt: 1,
        flows: [result('checkout', RunFlowStatus.FAIL), result('refund', RunFlowStatus.PASS)],
      },
    ];
    expect(passingFlowNames(latestFlowResults(runs)).sort()).toEqual(['checkout', 'refund']);
  });

  it('lets a newer failure replace an older pass', () => {
    const runs = [
      { createdAt: 1, flows: [result('checkout', RunFlowStatus.PASS)] },
      { createdAt: 2, flows: [result('checkout', RunFlowStatus.FAIL)] },
    ];
    expect(passingFlowNames(latestFlowResults(runs))).toEqual([]);
  });
});
