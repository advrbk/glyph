// Public entry points: source text in, output lines (and an error) out.

import type { Block } from './ast.js';
import type { Program } from './bytecode.js';
import { compileProgram } from './compiler.js';
import { CompileErrors, GlyphError, errorsOf, guardDepth } from './errors.js';
import { foldProgram, type FoldStats } from './fold.js';
import { Interpreter, OutOfFuel } from './interp.js';
import { parse } from './parser.js';
import { GlobalScope, resolve, type FnInfo } from './resolver.js';
import { VM } from './vm.js';
import type { Value } from './values.js';

export interface FrontEndResult {
  ast: Block;
  script: FnInfo;
  globals: GlobalScope;
  foldStats: FoldStats;
}

export interface FrontEndOptions {
  fold?: boolean;
  globals?: GlobalScope;
  repl?: boolean;
}

/** Parse, resolve and (optionally) fold. Throws GlyphError or CompileErrors. */
export function frontEnd(source: string, opts: FrontEndOptions = {}): FrontEndResult {
  const globals = opts.globals ?? new GlobalScope();
  const parsed = guardDepth('syntax', () => parse(source));
  const script = guardDepth('compile', () => resolve(parsed, globals, { allowRedeclare: opts.repl }));
  const foldStats = { folds: 0 };
  const ast = opts.fold === false ? parsed : guardDepth('compile', () => foldProgram(parsed, foldStats));
  return { ast, script, globals, foldStats };
}

export function compile(source: string, opts: FrontEndOptions = {}): Program {
  const fe = frontEnd(source, opts);
  return compileProgram(fe.ast, fe.script, fe.globals);
}

export interface RunResult {
  output: string[];
  /** The first error (syntax, compile or runtime), if any. */
  error: GlyphError | null;
  /** All compile errors when compilation failed. */
  errors: GlyphError[];
  value: Value;
  /** True when the run stopped because it hit the fuel limit. */
  outOfFuel: boolean;
  /** VM instructions executed (VM runs only). */
  steps: number;
}

export interface RunOptions {
  fold?: boolean;
  /** VM: instruction budget. Tree-walker: evaluation budget. */
  fuel?: number;
  /** Also forward each line to this callback as it is printed. */
  onOutput?: (line: string) => void;
}

function failed(e: unknown, output: string[]): RunResult {
  const errs = errorsOf(e);
  if (!errs) throw e;
  return { output, error: errs[0]!, errors: errs, value: null, outOfFuel: false, steps: 0 };
}

export function runVM(source: string, opts: RunOptions = {}): RunResult {
  const output: string[] = [];
  let program: Program;
  try {
    program = compile(source, { fold: opts.fold ?? true });
  } catch (e) {
    return failed(e, output);
  }
  const vm = new VM({
    out: (line) => {
      output.push(line);
      opts.onOutput?.(line);
    },
  });
  vm.load(program);
  const status = vm.run(opts.fuel ?? Infinity);
  return {
    output,
    error: vm.error,
    errors: vm.error ? [vm.error] : [],
    value: vm.result,
    outOfFuel: status === 'paused',
    steps: vm.steps,
  };
}

export function runTree(source: string, opts: RunOptions = {}): RunResult {
  const output: string[] = [];
  let ast: Block;
  try {
    ast = frontEnd(source, { fold: opts.fold ?? false }).ast;
  } catch (e) {
    return failed(e, output);
  }
  const interp = new Interpreter({
    out: (line) => {
      output.push(line);
      opts.onOutput?.(line);
    },
    fuel: opts.fuel,
  });
  try {
    const value = interp.run(ast);
    return { output, error: null, errors: [], value, outOfFuel: false, steps: 0 };
  } catch (e) {
    if (e instanceof OutOfFuel) return { output, error: null, errors: [], value: null, outOfFuel: true, steps: 0 };
    if (e instanceof GlyphError) return { output, error: e, errors: [e], value: null, outOfFuel: false, steps: 0 };
    throw e;
  }
}

export { CompileErrors, GlyphError };
