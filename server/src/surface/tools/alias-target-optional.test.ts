/**
 * A field that says "Alias for `flowName`" promises that a call may send it instead. When the
 * schema still requires `flowName`, the call fails validation before the handler can read the
 * alias. `reticle_flow_replay` did this: `{ flow: "checkout" }` was refused with "flowName Required".
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOLS } from './tools.js';

const ALIAS_OF = /^Alias for `([A-Za-z]+)`/;

describe('a field named as an alias', () => {
  it('stands in for a field that the schema does not require', () => {
    const broken: string[] = [];
    for (const tool of TOOLS) {
      const shape: Record<string, z.ZodTypeAny> = tool.inputSchema ?? {};
      for (const [field, schema] of Object.entries(shape)) {
        const target = ALIAS_OF.exec(schema.description ?? '')?.[1];
        const required = target === undefined ? undefined : shape[target];
        if (required !== undefined && !required.isOptional()) {
          broken.push(`${tool.name}: ${field} -> ${String(target)}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
