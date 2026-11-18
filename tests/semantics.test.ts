// Language semantics. Every program here runs on the VM (with and without
// constant folding) and on the tree-walker, and `out`/`err` fail the test if
// the three disagree.

import { describe, expect, it } from 'vitest';
import { err, out } from './helpers.js';

describe('values and operators', () => {
  it('does arithmetic on numbers', () => {
    expect(out('print(7 / 2, 7 % 3, -7 % 3, 2 * 3 + 1, 0.1 + 0.2)')).toBe('3.5 1 -1 7 0.30000000000000004');
    expect(out('print(1e308 * 10, -1e308 * 10, sqrt(-1), -0)')).toBe('inf -inf nan 0');
  });

  it('joins strings and arrays with ++ only', () => {
    expect(out('print("a" ++ "b", [1] ++ [2, 3])')).toBe('ab [1, 2, 3]');
    expect(err('print("a" + "b")')).toBe("1:11 cannot apply '+' to string and string (use ++ to join strings)");
    expect(err('print("a" ++ 1)')).toBe("1:11 cannot apply '++' to string and number (both sides must be strings, or both arrays)");
  });

  it('compares numbers with numbers and strings with strings', () => {
    expect(out('print(1 < 2, "b" > "a", 2 <= 2, "a" >= "b")')).toBe('true true true false');
    expect(err('print(1 < "2")')).toBe("1:9 cannot compare number with string using '<'");
  });

  it('compares arrays and maps by identity, ranges by value', () => {
    expect(out('let a = [1]\nprint(a == a, a == [1], {} == {}, 0..3 == 0..3, 0..3 == 0..=3, nil == false)'))
      .toBe('true false false true false false');
  });

  it('treats only false and nil as falsy', () => {
    expect(out('print(not 0, not "", not [], not nil, not false)')).toBe('false false false true true');
  });

  it('returns operand values from and/or and short-circuits', () => {
    expect(out('print(nil or "default", 0 and "yes", false and 1, nil or false)')).toBe('default yes false false');
    expect(out('fn boom() => error("evaluated")\nprint(false and boom(), true or boom())')).toBe('false true');
  });

  it('prints nested values with quotes and cycles safely', () => {
    expect(out('print(["a", 1, nil, [true]], {x: "y", "two words": 2})')).toBe('["a", 1, nil, [true]] {x: "y", "two words": 2}');
    expect(out('let a = [1]\npush(a, a)\nprint(a)')).toBe('[1, [...]]');
    expect(out('print(str(0..3), 1..=2, print, fn(x) => x)')).toBe('0..3 1..=2 <builtin print> <fn>');
    expect(out('fn named() => 1\nprint(named)')).toBe('<fn named>');
  });
});

describe('variables and scope', () => {
  it('uses lexical block scope and shadowing', () => {
    expect(out('let x = 1\ndo {\n  let x = 2\n  print(x)\n}\nprint(x)')).toBe('2\n1');
  });

  it('makes blocks, if and functions return their last expression', () => {
    expect(out('print(do { 1; 2 }, do { let a = 1 }, if false { 1 })')).toBe('2 nil nil');
    expect(out('fn f() { let a = 3\n a * 2 }\nprint(f())')).toBe('6');
  });

  it('gives a block ending in a declaration the value nil', () => {
    expect(out('fn f() {\n fn g() => 1\n}\nprint(f())')).toBe('nil');
  });

  it('treats assignment as an expression', () => {
    expect(out('let a = 0\nlet b = 0\na = b = 5\nprint(a, b, (a += 1))')).toBe('5 5 6');
  });

  it('runs compound assignment on fields and indexes, evaluating the target once', () => {
    expect(out('let calls = 0\nlet xs = [10, 20]\nfn i() { calls += 1; 1 }\nxs[i()] += 5\nprint(xs, calls)')).toBe('[10, 25] 1');
    expect(out('let m = {n: 1}\nm.n *= 10\nm.s = "a"\nm.s ++= "b"\nprint(m)')).toBe('{n: 10, s: "ab"}');
  });
});

describe('functions and closures', () => {
  it('captures variables by reference', () => {
    expect(out('let n = 1\nfn get() => n\nn = 2\nprint(get())')).toBe('2');
    expect(out('fn mk() { let c = 0\n fn() { c += 1; c } }\nlet a = mk()\nlet b = mk()\na()\nprint(a(), b())')).toBe('2 1');
  });

  it('gives each loop iteration its own variables', () => {
    expect(out('let fs = []\nfor i in 0..3 { push(fs, fn() => i) }\nprint(map(fs, fn(f) => f()))')).toBe('[0, 1, 2]');
    expect(out('let fs = []\nlet j = 0\nwhile j < 3 { j += 1\n let k = j\n push(fs, fn() => [j, k]) }\nprint(map(fs, fn(f) => f()))'))
      .toBe('[[3, 1], [3, 2], [3, 3]]');
  });

  it('lets closures see writes made after they were created', () => {
    expect(out('let fs = []\nfor i in 0..2 {\n let v = i\n push(fs, fn() => v)\n v = v * 10 + 5\n}\nprint(fs[0](), fs[1]())')).toBe('5 15');
  });

  it('captures through several levels of nesting', () => {
    expect(out('fn a(x) {\n fn b(y) {\n  fn c(z) => x + y + z\n  c\n }\n b\n}\nprint(a(1)(10)(100))')).toBe('111');
    expect(out('fn outer() { let v = 1\n fn mid() { fn inner() { v += 1 }\n inner()\n inner() }\n mid()\n v }\nprint(outer())')).toBe('3');
  });

  it('captures parameters', () => {
    expect(out('fn adder(n) => fn(x) => x + n\nconst add5 = adder(5)\nprint(add5(1), adder(-1)(1))')).toBe('6 0');
  });

  it('supports recursion and mutual recursion between local functions', () => {
    expect(out('fn fact(n) => if n <= 1 { 1 } else { n * fact(n - 1) }\nprint(fact(10))')).toBe('3628800');
    expect(out('fn f() {\n fn even(n) => n == 0 or odd(n - 1)\n fn odd(n) => n != 0 and even(n - 1)\n [even(4), odd(4)]\n}\nprint(f())')).toBe('[true, false]');
  });

  it('returns early from loops inside functions', () => {
    expect(out('fn find(xs) { for x in xs { if x > 2 { return x } }\n -1 }\nprint(find([1, 5, 9]), find([]))')).toBe('5 -1');
  });

  it('checks argument counts', () => {
    expect(err('fn f(a) => a\nf(1, 2)')).toBe("2:2 function 'f' expects 1 argument, got 2");
    expect(err('let g = fn(a, b) => a\ng()')).toBe('2:2 function expects 2 arguments, got 0');
  });

  it('reports a forward reference that runs too early', () => {
    expect(err('fn f() => later\nf()\nlet later = 1')).toBe("1:11 'later' was used before its definition ran");
    expect(out('fn f() => later\nlet later = 1\nprint(f())')).toBe('1');
  });

  it('limits call depth the same way on both engines', () => {
    expect(err('fn down(n) => if n == 0 { 0 } else { 1 + down(n - 1) }\nprint(down(5000))')).toBe('1:46 stack overflow (more than 1000 nested calls)');
    expect(out('fn down(n) => if n == 0 { 0 } else { 1 + down(n - 1) }\nprint(down(900))')).toBe('900');
  });
});

describe('loops', () => {
  it('iterates arrays, ranges, strings and map keys', () => {
    expect(out('for x in [1, 2] { print(x) }\nfor i in 3..5 { print(i) }\nfor i in 5..=5 { print(i) }\nfor c in "hi" { print(c) }\nfor k in {a: 1, b: 2} { print(k) }'))
      .toBe('1\n2\n3\n4\n5\nh\ni\na\nb');
  });

  it('runs empty ranges zero times', () => {
    expect(out('for i in 3..1 { print(i) }\nprint(len(3..1), len(1..=1))')).toBe('0 1');
  });

  it('sees elements pushed during the loop (index-based iteration)', () => {
    expect(out('let xs = [1]\nfor x in xs { if x < 4 { push(xs, x + 1) } }\nprint(xs)')).toBe('[1, 2, 3, 4]');
  });

  it('supports break and continue in nested loops', () => {
    expect(out('for i in 0..3 {\n for j in 0..3 {\n  if j == 1 { continue }\n  if j == 2 { break }\n  print(i, j)\n }\n}')).toBe('0 0\n1 0\n2 0');
  });

  it('cleans up block locals when breaking out of nested blocks', () => {
    expect(out('let total = 0\nfor i in 0..5 {\n let a = i\n do {\n  let b = a * 2\n  if b > 4 { break }\n  total += b\n }\n}\nprint(total)')).toBe('6');
  });

  it('can break from inside an expression', () => {
    expect(out('let r = []\nfor i in 0..5 { push(r, 10 + if i == 2 { break } else { i }) }\nprint(r)')).toBe('[10, 11]');
  });

  it('rejects things that cannot be looped over', () => {
    expect(err('for x in 5 { }')).toBe('1:1 cannot loop over a number');
    expect(err('let r = 0..1.5')).toBe('1:10 range end must be an integer, got 1.5');
  });
});

describe('arrays, maps and strings', () => {
  it('indexes and assigns', () => {
    expect(out('let a = [1, 2, 3]\na[0] = 9\nprint(a[0], a[2], "abc"[1])')).toBe('9 3 b');
    expect(err('let a = [1]\nprint(a[1])')).toBe('2:8 index 1 is out of bounds (length 1)');
    expect(err('let a = [1]\nprint(a[0.5])')).toBe('2:8 array index must be an integer, got 0.5');
    expect(err('print("abc"["x"])')).toBe('1:12 string index must be a number, got string');
  });

  it('reads map fields strictly and indexes loosely', () => {
    expect(out('let m = {a: 1}\nprint(m.a, m["a"], m["zz"])')).toBe('1 1 nil');
    expect(err('let m = {a: 1}\nprint(m.zz)')).toBe("2:9 map has no key 'zz'");
    expect(err('let m = {}\nm[1] = 2')).toBe('2:2 map keys must be strings, got number');
    expect(err('let m = {[1]: 2}')).toBe('1:9 map keys must be strings, got number');
    expect(err('print(5.x)')).toBe("1:9 cannot read field 'x' of a number");
  });
});

describe('standard library', () => {
  it('has the collection helpers', () => {
    expect(out('let a = [3, 1, 2]\nprint(len(a), push(a, 4), pop(a), a)')).toBe('3 [3, 1, 2] 4 [3, 1, 2]');
    expect(out('print(map(1..=3, fn(x) => x * x), filter([1, 2, 3, 4], fn(x) => x % 2 == 0), reduce([1, 2, 3], fn(a, b) => a + b, 10))'))
      .toBe('[1, 4, 9] [2, 4] 16');
    expect(out('let m = {b: 1, a: 2}\nprint(keys(m), has(m, "a"), has(m, "c"), len(m))')).toBe('["b", "a"] true false 2');
  });

  it('has string helpers', () => {
    expect(out('print(split("a,b,c", ","), join([1, "x", nil], "-"), slice("hello", 1, 3), slice([1, 2, 3], 0, 0))'))
      .toBe('["a", "b", "c"] 1-x-nil el []');
    expect(out('print(str(12) ++ "!", num("3.5") * 2, num("1e2"), num(" 4 "), num("4x"), num(7))')).toBe('12! 7 100 4 nil 7');
  });

  it('has math helpers', () => {
    expect(out('print(floor(2.7), round(2.5), abs(-3), sqrt(16), min(3, 1), max(3, 1))')).toBe('2 3 3 4 1 3');
  });

  it('checks argument counts and types', () => {
    expect(err('len()')).toBe('1:4 len expects 1 argument, got 0');
    expect(err('push([1])')).toBe('1:5 push expects 2 arguments, got 1');
    expect(err('assert()')).toBe('1:7 assert expects 1 to 2 arguments, got 0');
    expect(err('len(5)')).toBe('1:4 len expects a string, array, map or range, got a number');
    expect(err('min(1, "2")')).toBe('1:4 min expects a number as argument 2, got a string');
    expect(err('slice([1, 2], 1, 5)')).toBe('1:6 slice 1..5 is out of bounds (length 2)');
    expect(err('pop([])')).toBe('1:4 pop from an empty array');
  });

  it('runs callbacks from map/filter/reduce as ordinary calls', () => {
    expect(out('let seen = []\nlet r = map([1, 2], fn(x) { push(seen, x)\n return x * 10 })\nprint(r, seen)')).toBe('[10, 20] [1, 2]');
    expect(out('print(map([[1, 2], [3]], fn(xs) => reduce(xs, fn(a, b) => a + b, 0)))')).toBe('[3, 3]');
    expect(out('print(map([-1, 4], abs), reduce(["a", "b"], fn(acc, s) => acc ++ s, ""))')).toBe('[1, 4] ab');
  });

  it('reports errors inside callbacks at the callback, and callback misuse at the call', () => {
    expect(err('print(map([1, "x"], fn(v) => v * 2))')).toBe("1:32 cannot apply '*' to string and number");
    expect(err('print(map([1], fn(a, b) => a))')).toBe('1:10 function expects 2 arguments, got 1');
    expect(err('print(map([1], 5))')).toBe('1:10 cannot call a number');
    expect(err('print(filter(5, fn(x) => x))')).toBe('1:13 filter expects an array or range as argument 1, got a number');
  });

  it('raises user errors and assertion failures', () => {
    expect(err('error("bad {1 + 1}")')).toBe('1:6 bad 2');
    expect(err('assert(1 > 2, "math")')).toBe('1:7 assertion failed: math');
  });
});
