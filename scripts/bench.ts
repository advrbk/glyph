// Benchmarks: npm run bench [-- --runs N]
//
// Runs each program in bench/ on the bytecode VM (with and without constant
// folding) and on the tree-walking interpreter, using the bundled library in
// dist/ (built first), the same code the `glyph` command runs. Each cell is
// the median of N runs (default 3) after one warm-up run. All three must print
// the same output, or the benchmark stops.

import { build } from 'esbuild';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const root = join(import.meta.dirname, '..');
const lib = join(root, 'dist/glyph-lib.js');
await build({
  entryPoints: [join(root, 'src/glyph.ts')],
  outfile: lib,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
});
const glyph = (await import(pathToFileURL(lib).href)) as typeof import('../src/glyph.js');

const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? Number(process.argv[runsArg + 1]) : 3;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

type Run = () => { output: string[]; error: unknown; steps: number };

interface Timing {
  ms: number;
  output: string;
  steps: number;
}

/**
 * Time several engines on one program. Rounds are interleaved (A, B, C, A, B,
 * C, ...) so a change in background load hits every engine alike. A run that
 * takes longer than LONG_MS is timed once, to keep the whole benchmark short.
 */
function timeAll(runs: Run[]): Timing[] {
  const LONG_MS = 2500;
  const samples: number[][] = runs.map(() => []);
  const last: ReturnType<Run>[] = runs.map((r) => r()); // warm-up
  for (let round = 0; round < RUNS; round++) {
    runs.forEach((run, i) => {
      if (round > 0 && samples[i]![0]! > LONG_MS) return;
      const t0 = performance.now();
      last[i] = run();
      samples[i]!.push(performance.now() - t0);
    });
  }
  return runs.map((_, i) => {
    const err = last[i]!.error as Error | null;
    if (err) throw new Error(`benchmark failed: ${err.message}`);
    return { ms: median(samples[i]!), output: last[i]!.output.join('\n'), steps: last[i]!.steps };
  });
}

const files = readdirSync(join(root, 'bench')).filter((f) => f.endsWith('.gly')).sort();
const rows: string[] = [];
console.log(`node ${process.version}, ${os.cpus()[0]?.model.trim()}, median of ${RUNS} runs\n`);
for (const f of files) {
  const source = readFileSync(join(root, 'bench', f), 'utf8');
  const [vm, vmNoFold, tree] = timeAll([
    () => glyph.runVM(source, { fold: true }),
    () => glyph.runVM(source, { fold: false }),
    () => glyph.runTree(source),
  ]) as [Timing, Timing, Timing];
  if (vm.output !== tree.output || vm.output !== vmNoFold.output) throw new Error(`${f}: engines printed different output`);
  const speedup = tree.ms / vm.ms;
  const foldGain = vmNoFold.ms / vm.ms;
  const fewer = 1 - vm.steps / vmNoFold.steps;
  rows.push(`| ${f.replace('.gly', '').padEnd(9)} | ${tree.ms.toFixed(0).padStart(6)} | ${vm.ms.toFixed(0).padStart(5)} | ${speedup.toFixed(1).padStart(5)}x | ${vmNoFold.ms.toFixed(0).padStart(7)} | ${foldGain.toFixed(2)}x | ${(vmNoFold.steps / 1e6).toFixed(2).padStart(6)}M -> ${(vm.steps / 1e6).toFixed(2)}M (${(fewer * 100).toFixed(0)}% fewer) |`);
  console.log(`${f}: done`);
}

console.log('\n| Program   | Tree-walker ms | VM ms | VM speedup | VM, no folding ms | Folding speedup | VM instructions (no folding -> folding) |');
console.log('|---|---:|---:|---:|---:|---:|---|');
for (const r of rows) console.log(r);
