// Differential testing: run one program through three back ends and compare.
//
//   1. the bytecode VM with constant folding (the default),
//   2. the bytecode VM without folding,
//   3. the tree-walking interpreter (no folding, no bytecode).
//
// They must print exactly the same lines and stop with the same error message
// at the same line and column (or all finish). After a successful VM run the
// value stack must also be empty, which checks the compiler's stack-depth
// bookkeeping on every program.

import { compileProgram } from '../compiler.js';
import { errorsOf, type GlyphError } from '../errors.js';
import { frontEnd } from '../glyph.js';
import { Interpreter, OutOfFuel } from '../interp.js';
import { VM } from '../vm.js';
import { generateProgram } from './generate.js';

export interface Outcome {
  output: string[];
  error: string | null;
  outOfFuel: boolean;
}

export interface CaseResult {
  seed: number;
  source: string;
  /** Skipped because a run hit its fuel limit. */
  skipped: boolean;
  agreed: boolean;
  /** All engines agreed that the program stops with a runtime error. */
  endedInError: boolean;
  detail: string;
  steps: number;
}

export const VM_FUEL = 2_000_000;
const TREE_FUEL = 20_000_000;
const MAX_OUTPUT_LINES = 5_000;
/** Wall-clock safety net per engine run; a program that needs longer is skipped. */
const DEADLINE_MS = 5_000;

function errText(e: GlyphError | null): string | null {
  if (!e) return null;
  return `${e.kind} error at ${e.pos ? `${e.pos.line}:${e.pos.col}` : '?'}: ${e.message}`;
}

function capped(lines: string[]): (line: string) => void {
  return (line) => {
    if (lines.length < MAX_OUTPUT_LINES) lines.push(line);
  };
}

export function runOnVM(source: string, fold: boolean): Outcome & { steps: number; leftover: number } {
  const output: string[] = [];
  let fe;
  try {
    fe = frontEnd(source, { fold });
  } catch (e) {
    const errs = errorsOf(e);
    if (!errs) throw e;
    return { output, error: errText(errs[0]!), outOfFuel: false, steps: 0, leftover: 0 };
  }
  const program = compileProgram(fe.ast, fe.script, fe.globals);
  const vm = new VM({ out: capped(output) });
  vm.load(program);
  // Run in slices so one slow program (huge strings, say) cannot hang the fuzzer.
  const deadline = performance.now() + DEADLINE_MS;
  let status = vm.run(Math.min(VM_FUEL, 50_000));
  while (status === 'paused' && vm.steps < VM_FUEL && performance.now() < deadline) {
    status = vm.run(Math.min(50_000, VM_FUEL - vm.steps));
  }
  return {
    output,
    error: errText(vm.error),
    outOfFuel: status === 'paused',
    steps: vm.steps,
    leftover: status === 'done' ? vm.sp : 0,
  };
}

export function runOnTree(source: string): Outcome {
  const output: string[] = [];
  let fe;
  try {
    fe = frontEnd(source, { fold: false });
  } catch (e) {
    const errs = errorsOf(e);
    if (!errs) throw e;
    return { output, error: errText(errs[0]!), outOfFuel: false };
  }
  const interp = new Interpreter({ out: capped(output), fuel: TREE_FUEL, deadline: performance.now() + DEADLINE_MS });
  try {
    interp.run(fe.ast);
    return { output, error: null, outOfFuel: false };
  } catch (e) {
    if (e instanceof OutOfFuel) return { output, error: null, outOfFuel: true };
    const errs = errorsOf(e);
    if (!errs) throw e;
    return { output, error: errText(errs[0]!), outOfFuel: false };
  }
}

function firstDifference(a: string[], b: string[]): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
  }
  return 'no difference';
}

/** A crash inside an engine (a JS exception, not a Glyph error) counts as a disagreement. */
function guarded<T extends Outcome>(run: () => T, fallback: Omit<T, keyof Outcome>): T & { crash?: string } {
  try {
    return run();
  } catch (e) {
    const crash = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ...(fallback as T), output: [], error: null, outOfFuel: false, crash };
  }
}

export function compareSource(source: string, seed = -1): CaseResult {
  const folded = guarded(() => runOnVM(source, true), { steps: 0, leftover: 0 });
  const plain = guarded(() => runOnVM(source, false), { steps: 0, leftover: 0 });
  const tree = guarded(() => runOnTree(source), {});
  const base = { seed, source, steps: folded.steps };
  const crashes = [['vm', folded.crash], ['vm without folding', plain.crash], ['tree-walker', tree.crash]]
    .filter(([, c]) => c)
    .map(([name, c]) => `${name} crashed: ${c}`);
  if (crashes.length) {
    return { ...base, skipped: false, agreed: false, endedInError: false, detail: crashes.join('\n') };
  }

  if (folded.outOfFuel || plain.outOfFuel || tree.outOfFuel) {
    return { ...base, skipped: true, agreed: true, endedInError: false, detail: 'out of fuel' };
  }
  const problems: string[] = [];
  if (folded.error?.startsWith('syntax') || folded.error?.startsWith('compile')) {
    problems.push(`generator produced an invalid program: ${folded.error}`);
  }
  const pairs: [string, Outcome][] = [['vm without folding', plain], ['tree-walker', tree]];
  for (const [name, o] of pairs) {
    if (o.output.join('\n') !== folded.output.join('\n')) {
      problems.push(`output differs (vm vs ${name}) at ${firstDifference(folded.output, o.output)}`);
    }
    if (o.error !== folded.error) {
      problems.push(`error differs (vm vs ${name}): ${folded.error} | ${o.error}`);
    }
  }
  if (folded.leftover !== 0) problems.push(`vm left ${folded.leftover} values on the stack (folded)`);
  if (plain.leftover !== 0) problems.push(`vm left ${plain.leftover} values on the stack (unfolded)`);
  return {
    ...base,
    skipped: false,
    agreed: problems.length === 0,
    endedInError: folded.error !== null,
    detail: problems.join('\n'),
  };
}

export function compareSeed(seed: number): CaseResult {
  return compareSource(generateProgram(seed), seed);
}

export interface Totals {
  programs: number;
  agreed: number;
  disagreed: number;
  skipped: number;
  endedInError: number;
  vmInstructions: number;
  failures: CaseResult[];
}

export function runSeeds(from: number, count: number, onCase?: (r: CaseResult) => void): Totals {
  const t: Totals = { programs: 0, agreed: 0, disagreed: 0, skipped: 0, endedInError: 0, vmInstructions: 0, failures: [] };
  for (let seed = from; seed < from + count; seed++) {
    const r = compareSeed(seed);
    t.programs++;
    t.vmInstructions += r.steps;
    if (r.skipped) t.skipped++;
    else if (r.agreed) {
      t.agreed++;
      if (r.endedInError) t.endedInError++;
    } else {
      t.disagreed++;
      if (t.failures.length < 20) t.failures.push(r);
    }
    onCase?.(r);
  }
  return t;
}
