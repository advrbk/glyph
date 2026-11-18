// Edge cases found by hand-written adversarial programs during review. Each one
// used to crash an engine with a JavaScript exception, made the engines
// disagree, or gave a misleading message. `out`/`err` run every program on the
// VM (with and without folding) and on the tree-walker and require agreement.

import { describe, expect, it } from 'vitest';
import { runTree, runVM } from '../src/glyph.js';
import { createSession } from '../src/repl.js';
import { err, out } from './helpers.js';

describe('limits of the host', () => {
  it('keeps ranges within the integers a double can count exactly', () => {
    // Past 2^53, i + 1 === i: the VM used to repeat items and the tree-walker looped forever.
    expect(err('for i in 9007199254740992..9007199254740995 { print(i) }'))
      .toBe('1:26 range start 9007199254740992 is too large (ranges must stay within +/-9007199254740991)');
    expect(err('print(len(0..1e300))')).toBe('1:12 range end 1e+300 is too large (ranges must stay within +/-9007199254740991)');
    expect(out('let r = -9007199254740991..=9007199254740991\nprint(len(r))')).toBe('18014398509481984');
    expect(out('print(map(9007199254740989..=9007199254740991, fn(x) => x - 9007199254740989))')).toBe('[0, 1, 2]');
  });

  it('prints very deeply nested values instead of overflowing the JS stack', () => {
    const r = out('let a = []\nfor i in 0..100000 { a = [a] }\nlet s = str(a)\nprint(len(s), slice(s, 0, 3), slice(s, len(s) - 3, len(s)))');
    expect(r).toBe('200002 [[[ ]]]');
    expect(out('fn f() {\n let m = {}\n for i in 0..50000 { m = {next: m} }\n "{m}" == str(m)\n}\nprint(f())')).toBe('true');
    // Cycles still print as [...] and {...}.
    expect(out('let a = [1]\npush(a, a)\nlet m = {a: a}\nm.me = m\nprint(a, m)')).toBe('[1, [...]] {a: [1, [...]], me: {...}}');
  });

  it('reports a string that grows past the JS limit as a runtime error, not a stack overflow', () => {
    // The tree-walker used to call this "stack overflow (more than 1000 nested calls)"
    // and the VM crashed with a JavaScript RangeError.
    expect(err('fn grow() {\n  let s = "abcdefgh"\n  while true { s = s ++ s }\n}\ngrow()')).toBe('3:22 string is too long');
    expect(err('let s = "abcdefgh"\nwhile true { s ++= s }')).toBe('2:16 string is too long');
    expect(err('let s = "abcdefgh"\nwhile true { s = "{s}{s}" }')).toBe('2:18 string is too long');
  });

  it('turns absurdly deep nesting into an error instead of a crash', () => {
    const programs = [
      `print(${'('.repeat(100000)}1${')'.repeat(100000)})`,
      `print(${'-'.repeat(100000)}1)`,
      `let x = 0${' + 1'.repeat(100000)}\nprint(x)`,
    ];
    for (const p of programs) {
      for (const r of [runVM(p), runVM(p, { fold: false }), runTree(p)]) {
        expect(r.error?.message).toBe('the program is nested too deeply to compile');
      }
    }
  });
});

describe('source text', () => {
  it('skips a byte order mark at the start of a file', () => {
    expect(out('﻿print("ok")')).toBe('ok');
  });

  it('names the whole character in "unexpected character", including emoji', () => {
    expect(err('let \u{1F600} = 1')).toBe("1:5 unexpected character '\u{1F600}'");
    expect(err('let café = 1')).toBe("1:8 unexpected character 'é'");
  });

  it('allows keywords after a dot, as map literals allow them as keys', () => {
    expect(out('let m = {if: 1, while: 2}\nm.for = 3\nm.if += 10\nprint(m.if, m.while, m["for"], m)')).toBe('11 2 3 {if: 11, while: 2, for: 3}');
  });
});

describe('repl', () => {
  it('reports a compile-time limit instead of throwing', () => {
    const s = createSession(() => {});
    const args = Array.from({ length: 300 }, (_, i) => i).join(', ');
    expect(s.feed(`print(${args})`)).toMatch(/^compile error: too many arguments \(the limit is 255\)/);
    expect(s.feed('1 + 1')).toBe('=> 2');
  });
});
