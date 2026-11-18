// Constant folding, the disassembler, the bytecode format and the REPL.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Op, OPERANDS } from '../src/bytecode.js';
import { disassemble, instructions } from '../src/disasm.js';
import { compile, frontEnd, runVM } from '../src/glyph.js';
import { createSession } from '../src/repl.js';
import { block } from './helpers.js';

const folded = (src: string) => block(frontEnd(src).ast).slice(1, -1);
const opsOf = (src: string, fold = true) => instructions(compile(src, { fold }).main).map((i) => Op[i.op]);

describe('constant folding', () => {
  it('folds arithmetic, comparison, concatenation and not', () => {
    expect(folded('print(2 * 3 + 1, "a" ++ "b", not true, 1 < 2, -(4))')).toBe('(call print 7 "ab" false true -4)');
  });

  it('propagates literal constants into later uses', () => {
    expect(folded('const RATE = 0.25\nconst DOUBLE = RATE * 2\nprint(DOUBLE * 10)')).toBe('(const RATE 0.25) (const DOUBLE 0.5) (call print 5)');
  });

  it('does not propagate let variables or non-literal constants', () => {
    expect(folded('let a = 2\nconst b = [1]\nprint(a * 2, b)')).toBe('(let a 2) (const b [1]) (call print (* a 2) b)');
  });

  it('does not reassociate: x * 2 * 3 keeps both multiplications', () => {
    expect(folded('let x = 1\nprint(x * 2 * 3, 2 * 3 * x)')).toBe('(let x 1) (call print (* (* x 2) 3) (* 6 x))');
  });

  it('leaves operations that would fail for run time', () => {
    expect(folded('print(1 / 0, "a" + 1, -"s")')).toBe('(call print (/ 1 0) (+ "a" 1) (- "s"))');
  });

  it('removes dead if branches and simplifies and/or', () => {
    expect(folded('let x = 1\nprint(if true { x } else { x() })')).toBe('(let x 1) (call print {x})');
    expect(folded('let x = 1\nprint(if nil { 1 }, false and x, nil or x, 1 and x)')).toBe('(let x 1) (call print nil false x x)');
  });

  it('merges literal parts of interpolated strings', () => {
    expect(folded('const n = 3\nprint("n={n}!")')).toBe('(const n 3) (call print "n=3!")');
    expect(folded('let x = 1\nprint("{1 + 1}-{x}")')).toBe('(let x 1) (call print (interp "2-" x ""))');
  });

  it('does not fold a constant read by a closure before the constant is defined', () => {
    // f() runs before K exists, so it must still fail, as it does without folding.
    const src = 'fn f() => K * 2\nprint(f())\nconst K = 5';
    expect(runVM(src).error?.message).toBe("'K' was used before its definition ran");
  });

  it('shrinks the bytecode', () => {
    const src = 'const W = 640\nconst H = 480\nlet x = 0\nx = x + W * H / 2';
    expect(opsOf(src, false).filter((o) => o === 'MUL' || o === 'DIV')).toHaveLength(2);
    expect(opsOf(src, true).filter((o) => o === 'MUL' || o === 'DIV')).toHaveLength(0);
  });
});

describe('bytecode and disassembler', () => {
  it('disassembles a small program', () => {
    const text = disassemble(compile('fn add(a, b) => a + b\nprint(add(1, 2))'));
    expect(text).toBe([
      '== <script> (arity 0, 3 constants, 22 bytes) ==',
      '0000    1:1  CLOSURE            0 <fn add>',
      '0003      |  DEFINE_GLOBAL      0 add',
      '0006    2:1  GET_BUILTIN        0 print',
      '0008      |  GET_GLOBAL         0 add',
      '0011      |  CONST              1 1',
      '0014      |  CONST              2 2',
      '0017      |  CALL               2',
      '0019      |  CALL               1',
      '0021    1:1  RETURN',
      '',
      '== fn add (arity 2, 0 constants, 6 bytes) ==',
      '0000   1:17  GET_LOCAL          0 a',
      '0002      |  GET_LOCAL          1 b',
      '0004      |  ADD',
      '0005      |  RETURN',
      '',
    ].join('\n'));
  });

  it('boxes only captured variables and shows what a closure captures', () => {
    const text = disassemble(compile('fn mk() {\n let n = 0\n let unused = 1\n fn() { n += 1 }\n}'));
    expect(text).toContain('PUSH_BOX');
    expect(text).toContain('CLOSURE            2 <fn anonymous> [n=slot 0]');
    expect(text).toContain('GET_CAPTURED       0 n');
    expect(text.match(/PUSH_BOX/g)).toHaveLength(1);
  });

  it('wraps a captured loop variable in a new box on every iteration', () => {
    // Slot 0 holds the hidden iterator, slot 1 the loop variable.
    const ops = disassemble(compile('for i in 0..3 { print(fn() => i) }'));
    expect(ops).toMatch(/ITER_NEXT[\s\S]*BOX_SLOT\s+1 i/);
  });

  it('has an operand shape for every opcode', () => {
    const names = Object.keys(Op).filter((k) => Number.isNaN(Number(k)));
    for (const n of names) expect(OPERANDS[Op[n as keyof typeof Op]], n).toBeDefined();
  });

  it('uses the right opcode numbers in the VM dispatch switch', () => {
    // vm.ts writes `case 12 /* GET_BOX */:` so the switch compiles to a jump
    // table even under loaders that do not inline enums. Check every label.
    const vm = readFileSync(join(import.meta.dirname, '..', 'src', 'vm.ts'), 'utf8');
    const labels = [...vm.matchAll(/case (\d+) \/\* ([A-Z_0-9]+) \*\//g)];
    expect(labels.length).toBeGreaterThan(50);
    for (const [, num, name] of labels) expect(Op[Number(num)], `case ${num} /* ${name} */`).toBe(name);
    const covered = new Set(labels.map((m) => m[2]));
    for (const n of Object.keys(Op).filter((k) => Number.isNaN(Number(k)))) expect(covered.has(n), n).toBe(true);
  });

  it('decodes every instruction of every example to a known opcode', () => {
    const dir = join(import.meta.dirname, '..', 'examples');
    for (const f of ['fib.gly', 'closures.gly', 'life.gly', 'sort.gly']) {
      const text = disassemble(compile(readFileSync(join(dir, f), 'utf8')));
      expect(text).not.toMatch(/\?\d/);
    }
  });
});

describe('repl', () => {
  it('keeps globals between lines and prints values', () => {
    const printed: string[] = [];
    const s = createSession((l) => printed.push(l));
    expect(s.feed('let x = 40')).toBe('');
    expect(s.feed('x + 2')).toBe('=> 42');
    expect(s.feed('fn twice(f, v) => f(f(v))')).toBe('');
    expect(s.feed('twice(fn(n) => n * 3, x)')).toBe('=> 360');
    expect(s.feed('"str"')).toBe('=> "str"');
    expect(s.feed('print("hi")')).toBe('');
    expect(printed).toEqual(['hi']);
  });

  it('asks for more input when a line is unfinished', () => {
    const s = createSession(() => {});
    expect(s.feed('fn f(x) {')).toBeNull();
    expect(s.feed('fn f(x) {\n  x * 2')).toBeNull();
    expect(s.feed('fn f(x) {\n  x * 2\n}')).toBe('');
    expect(s.feed('f(21)')).toBe('=> 42');
  });

  it('reports errors and keeps going', () => {
    const s = createSession(() => {});
    expect(s.feed('nope')).toContain("undefined name 'nope'");
    expect(s.feed('1 / 0')).toContain('division by zero');
    expect(s.feed('let y = 1')).toBe('');
    expect(s.feed('let y = y + 1')).toContain("cannot use 'y' before its definition");
    expect(s.feed('let z = 2')).toBe('');
    expect(s.feed('let z = 3')).toBe('');
    expect(s.feed('z')).toBe('=> 3');
  });
});
