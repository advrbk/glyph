// Long differential fuzz run: npm run fuzz -- [--seeds N] [--from S] [--save DIR]
//
// Generates N random programs (seeds S .. S+N-1), runs each on the VM with and
// without constant folding and on the tree-walker, and reports how many agreed.
// Disagreeing programs are written to DIR (default fuzz-failures/) so they can
// be replayed with `npm run glyph -- run <file>` and `--tree`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSeeds } from '../src/fuzz/differential.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const seeds = arg('seeds', 20_000);
const from = arg('from', 1_000_000);
const saveIdx = process.argv.indexOf('--save');
const saveDir = saveIdx >= 0 ? process.argv[saveIdx + 1]! : 'fuzz-failures';

const started = performance.now();
let done = 0;
const totals = runSeeds(from, seeds, () => {
  done++;
  if (done % 1000 === 0) {
    const s = ((performance.now() - started) / 1000).toFixed(0);
    process.stdout.write(`  ${done}/${seeds} programs (${s} s)\n`);
  }
});
const seconds = (performance.now() - started) / 1000;

console.log('');
console.log(`seeds ${from}..${from + seeds - 1}`);
console.log(`programs generated:            ${totals.programs}`);
console.log(`all three engines agreed:      ${totals.agreed}`);
console.log(`  of which ended in an error:  ${totals.endedInError}`);
console.log(`skipped (hit the fuel limit):  ${totals.skipped}`);
console.log(`disagreements:                 ${totals.disagreed}`);
console.log(`VM instructions executed:      ${totals.vmInstructions.toLocaleString('en-US')}`);
console.log(`time:                          ${seconds.toFixed(1)} s`);

if (totals.failures.length) {
  mkdirSync(saveDir, { recursive: true });
  for (const f of totals.failures) {
    const file = join(saveDir, `seed-${f.seed}.gly`);
    writeFileSync(file, f.source);
    console.log(`\nseed ${f.seed} -> ${file}\n${f.detail}`);
  }
  process.exitCode = 1;
}
