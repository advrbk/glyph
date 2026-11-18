import type { Block, Expr, Stmt } from '../src/ast.js';
import { formatError } from '../src/errors.js';
import { runTree, runVM, type RunResult } from '../src/glyph.js';

/** Print an expression as an s-expression, to check how the parser grouped it. */
export function sexpr(e: Expr): string {
  switch (e.kind) {
    case 'Num': return String(e.value);
    case 'Str': return JSON.stringify(e.value);
    case 'Bool': return String(e.value);
    case 'Nil': return 'nil';
    case 'Ident': return e.name;
    case 'Interp': return `(interp ${e.parts.map((p) => (typeof p === 'string' ? JSON.stringify(p) : sexpr(p))).join(' ')})`;
    case 'Array': return `[${e.items.map(sexpr).join(' ')}]`;
    case 'Map': return `{${e.entries.map((en) => `${typeof en.key === 'string' ? en.key : sexpr(en.key)}: ${sexpr(en.value)}`).join(', ')}}`;
    case 'Unary': return `(${e.op} ${sexpr(e.operand)})`;
    case 'Binary': case 'Logical': return `(${e.op} ${sexpr(e.left)} ${sexpr(e.right)})`;
    case 'Range': return `(${e.inclusive ? '..=' : '..'} ${sexpr(e.start)} ${sexpr(e.end)})`;
    case 'Assign': return `(${e.op} ${sexpr(e.target)} ${sexpr(e.value)})`;
    case 'Call': return `(call ${sexpr(e.callee)}${e.args.map((a) => ' ' + sexpr(a)).join('')})`;
    case 'Index': return `(index ${sexpr(e.object)} ${sexpr(e.index)})`;
    case 'Field': return `(. ${sexpr(e.object)} ${e.name})`;
    case 'Fn': return `(fn (${e.params.map((p) => p.name).join(' ')}) ${block(e.body)})`;
    case 'If': return `(if ${sexpr(e.cond)} ${block(e.then)}${e.else ? ' ' + (e.else.kind === 'If' ? sexpr(e.else) : block(e.else)) : ''})`;
    case 'Block': return block(e);
  }
}

function stmt(s: Stmt): string {
  switch (s.kind) {
    case 'Let': return `(${s.constant ? 'const' : 'let'} ${s.name}${s.init ? ' ' + sexpr(s.init) : ''})`;
    case 'FnDecl': return `(fndecl ${s.name} ${sexpr(s.fn)})`;
    case 'Return': return s.value ? `(return ${sexpr(s.value)})` : '(return)';
    case 'Break': return '(break)';
    case 'Continue': return '(continue)';
    case 'While': return `(while ${sexpr(s.cond)} ${block(s.body)})`;
    case 'For': return `(for ${s.name} ${sexpr(s.iterable)} ${block(s.body)})`;
    case 'ExprStmt': return sexpr(s.expr);
  }
}

export function block(b: Block): string {
  return `{${b.stmts.map(stmt).join(' ')}}`;
}

/** Run on both engines, check they agree, and return the VM result. */
export function both(source: string): RunResult & { text: string } {
  const vm = runVM(source);
  const vmNoFold = runVM(source, { fold: false });
  const tree = runTree(source);
  const show = (r: RunResult) =>
    r.output.join('\n') + (r.error ? `\n${formatError(r.error, source, 'test.gly')}` : '');
  const text = show(vm);
  if (show(tree) !== text || show(vmNoFold) !== text) {
    throw new Error(`engines disagree on:\n${source}\n--- vm:\n${text}\n--- vm (no fold):\n${show(vmNoFold)}\n--- tree:\n${show(tree)}`);
  }
  return { ...vm, text };
}

/** Output lines of a program that must run without errors on both engines. */
export function out(source: string): string {
  const r = both(source);
  if (r.error) throw new Error(`unexpected error: ${formatError(r.error, source)}`);
  return r.output.join('\n');
}

/** The error message (with line:col) a program stops with, on both engines. */
export function err(source: string): string {
  const r = both(source);
  if (!r.error) throw new Error(`expected an error from:\n${source}`);
  const p = r.error.pos;
  return `${p ? `${p.line}:${p.col} ` : ''}${r.error.message}`;
}
