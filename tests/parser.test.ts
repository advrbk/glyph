import { describe, expect, it } from 'vitest';
import type { GlyphError } from '../src/errors.js';
import { parse } from '../src/parser.js';
import { block } from './helpers.js';

const p = (src: string) => block(parse(src)).slice(1, -1);
const syntaxError = (src: string) => {
  try {
    parse(src);
  } catch (e) {
    const g = e as GlyphError;
    return `${g.pos?.line}:${g.pos?.col} ${g.message}`;
  }
  return 'no error';
};

describe('parser: precedence and associativity', () => {
  it('binds * tighter than + and both to the left', () => {
    expect(p('1 + 2 * 3 - 4')).toBe('(- (+ 1 (* 2 3)) 4)');
    expect(p('8 / 4 / 2')).toBe('(/ (/ 8 4) 2)');
  });

  it('puts ++ below arithmetic and ranges below ++', () => {
    expect(p('"n" ++ a + 1')).toBe('(++ "n" (+ a 1))');
    expect(p('0..n + 1')).toBe('(.. 0 (+ n 1))');
    expect(p('a..=b')).toBe('(..= a b)');
  });

  it('orders comparison, equality, and, or', () => {
    expect(p('a < b == c > d')).toBe('(== (< a b) (> c d))');
    expect(p('a or b and c')).toBe('(or a (and b c))');
    expect(p('not a == b')).toBe('(== (not a) b)');
  });

  it('makes assignment right-associative and lowest', () => {
    expect(p('a = b = 1 + 2')).toBe('(= a (= b (+ 1 2)))');
    expect(p('xs[i] += 1')).toBe('(+= (index xs i) 1)');
    expect(p('m.k ++= "x"')).toBe('(++= (. m k) "x")');
  });

  it('applies unary minus before postfix and binary operators', () => {
    expect(p('-a.b * 2')).toBe('(* (- (. a b)) 2)');
    expect(p('- -x')).toBe('(- (- x))');
  });

  it('chains calls, indexing and fields', () => {
    expect(p('f(1)(2)[0].name')).toBe('(. (index (call (call f 1) 2) 0) name)');
  });

  it('desugars the pipe operator into a call', () => {
    expect(p('xs |> map(f) |> len')).toBe('(call len (call map xs f))');
    expect(p('x |> f')).toBe('(call f x)');
    expect(p('a + 1 |> g(2)')).toBe('(call g (+ a 1) 2)');
  });

  it('parses if/else chains, blocks and lambdas as expressions', () => {
    expect(p('let x = if a { 1 } else if b { 2 } else { 3 }')).toBe('(let x (if a {1} (if b {2} {3})))');
    expect(p('1 + do { let t = 2; t }')).toBe('(+ 1 {(let t 2) t})');
    expect(p('fn(a, b) => a + b')).toBe('(fn (a b) {(+ a b)})');
    expect(p('fn add(a, b) { a + b }')).toBe('(fndecl add (fn (a b) {(+ a b)}))');
  });

  it('parses map literals with name, string and computed keys', () => {
    expect(p('let m = {a: 1, "b c": 2, [k]: 3,}')).toBe('(let m {a: 1, b c: 2, k: 3})');
    expect(p('let e = {}')).toBe('(let e {})');
  });

  it('parses interpolation parts', () => {
    expect(p('"x={x + 1}!"')).toBe('(interp "x=" (+ x 1) "!")');
  });

  it('parses loops and control statements', () => {
    expect(p('for i in 0..3 { if i == 1 { continue }; print(i) }')).toBe('(for i (.. 0 3) {(if (== i 1) {(continue)}) (call print i)})');
    expect(p('while true { break }')).toBe('(while true {(break)})');
    expect(p('fn f() {\n  return\n}')).toBe('(fndecl f (fn () {(return)}))');
  });
});

describe('parser: line breaks', () => {
  it('does not call or index across a line break', () => {
    expect(p('let a = b\n(c)')).toBe('(let a b) c');
    expect(p('let a = b\n[1]')).toBe('(let a b) [1]');
    expect(p('let a = b\n-1')).toBe('(let a b) (- 1)');
    expect(p('let a = b -\n1')).toBe('(let a (- b 1))');
  });

  it('continues an expression when the next line starts with an operator', () => {
    expect(p('let a = 1\n  + 2')).toBe('(let a (+ 1 2))');
    expect(p('xs\n  |> len')).toBe('(call len xs)');
  });

  it('requires a line break or ; between statements', () => {
    expect(syntaxError('let a = 1 let b = 2')).toBe("1:11 expected a new line or ';' before 'let'");
    expect(p('let a = 1; let b = 2')).toBe('(let a 1) (let b 2)');
  });
});

describe('parser: errors', () => {
  it('reports what it expected and what it found', () => {
    expect(syntaxError('print(1, 2')).toBe("1:11 expected ')' after the arguments, found end of input");
    expect(syntaxError('let = 3')).toBe("1:5 expected a name after 'let', found '='");
    expect(syntaxError('let if = 3')).toBe("1:5 'if' is a keyword and cannot be used as a name");
    expect(syntaxError('1 +')).toBe('1:4 expected an expression, found end of input');
    expect(syntaxError('const k')).toBe("1:8 constant 'k' needs a value");
  });

  it('rejects chained comparisons and ranges', () => {
    expect(syntaxError('a < b < c')).toBe("1:7 comparisons cannot be chained; use 'and' to combine them");
    expect(syntaxError('a == b == c')).toBe("1:8 comparisons cannot be chained; use 'and' to combine them");
    expect(syntaxError('0..1..2')).toBe('1:5 ranges cannot be chained');
  });

  it('rejects invalid assignment targets', () => {
    expect(syntaxError('f() = 1')).toBe('1:5 invalid assignment target');
    expect(syntaxError('1 = 2')).toBe('1:3 invalid assignment target');
  });

  it('rejects named function expressions and empty interpolations', () => {
    expect(syntaxError('let f = fn g() => 1')).toBe("1:12 a named function must be a statement; write 'fn(...)' for a function value");
    expect(syntaxError('"{}"')).toBe('1:3 empty interpolation; put an expression between { and }');
  });
});
