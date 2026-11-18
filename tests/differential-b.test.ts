// Differential testing, part b: random programs from fixed seeds run on the VM
// (with and without constant folding) and on the tree-walker, which must agree
// on every printed line and on the final error. See src/fuzz/.

import { describe, expect, it } from 'vitest';
import { runSeeds } from '../src/fuzz/differential.js';

const FROM = 2500;
const COUNT = 2500;

describe(`differential fuzzing (seeds ${FROM}..${FROM + COUNT - 1})`, () => {
  it('all engines agree on every generated program', () => {
    const t = runSeeds(FROM, COUNT);
    const report = t.failures.map((f) => `seed ${f.seed}:\n${f.detail}\n${f.source}`).join('\n\n');
    expect(t.disagreed, report).toBe(0);
    // Most programs must actually run to completion, not just be skipped.
    expect(t.skipped).toBeLessThan(COUNT * 0.02);
    expect(t.agreed - t.endedInError).toBeGreaterThan(COUNT * 0.4);
    console.log(`differential ${FROM}..${FROM + COUNT - 1}: ${t.agreed} agreed (${t.endedInError} ended in an error), ${t.skipped} skipped, ${t.disagreed} disagreed, ${t.vmInstructions} VM instructions`);
  });
});
