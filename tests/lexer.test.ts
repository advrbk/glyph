import { describe, expect, it } from 'vitest';
import { GlyphError } from '../src/errors.js';
import { lex } from '../src/lexer.js';

const kinds = (src: string) => lex(src).map((t) => (t.type === 'punct' || t.type === 'kw' || t.type === 'ident' ? t.text : t.type === 'num' ? `#${t.num}` : t.type === 'eof' ? 'EOF' : `${t.type}:${JSON.stringify(t.value)}`));

describe('lexer', () => {
  it('splits operators, longest match first', () => {
    expect(kinds('a ++= b ..= c .. d |> e => f')).toEqual(['a', '++=', 'b', '..=', 'c', '..', 'd', '|>', 'e', '=>', 'f', 'EOF']);
    expect(kinds('x<=y!=z==w')).toEqual(['x', '<=', 'y', '!=', 'z', '==', 'w', 'EOF']);
  });

  it('reads numbers without eating a range operator', () => {
    expect(kinds('1..5')).toEqual(['#1', '..', '#5', 'EOF']);
    expect(kinds('1.5 2e3 7.25e-2 0')).toEqual(['#1.5', '#2000', '#0.0725', '#0', 'EOF']);
  });

  it('separates keywords from identifiers', () => {
    const toks = lex('let lettuce fn fns');
    expect(toks.map((t) => t.type)).toEqual(['kw', 'ident', 'kw', 'ident', 'eof']);
  });

  it('records line, column and line breaks', () => {
    const toks = lex('let a = 1\n  print(a)');
    const p = toks.find((t) => t.text === 'print')!;
    expect([p.line, p.col, p.nl]).toEqual([2, 3, true]);
    expect(toks.find((t) => t.text === '=')!.nl).toBe(false);
  });

  it('skips comments', () => {
    expect(kinds('a # comment ( [ "\nb')).toEqual(['a', 'b', 'EOF']);
  });

  it('cooks escape sequences', () => {
    expect(lex('"a\\nb\\t\\"q\\" \\{x\\}"')[0]!.value).toBe('a\nb\t"q" {x}');
  });

  it('splits interpolated strings into parts', () => {
    expect(kinds('"a{x}b{y + 1}c"')).toEqual(['strStart:"a"', 'x', 'strMid:"b"', 'y', '+', '#1', 'strEnd:"c"', 'EOF']);
  });

  it('handles braces and strings nested inside an interpolation', () => {
    expect(kinds('"m={ {k: "v"}.k }!"')).toEqual(['strStart:"m="', '{', 'k', ':', 'str:"v"', '}', '.', 'k', 'strEnd:"!"', 'EOF']);
    expect(kinds('"outer {"inner {1}"} end"')).toEqual(['strStart:"outer "', 'strStart:"inner "', '#1', 'strEnd:""', 'strEnd:" end"', 'EOF']);
  });

  it('reports bad input with a position', () => {
    const at = (src: string) => {
      try {
        lex(src);
      } catch (e) {
        const g = e as GlyphError;
        return `${g.pos?.line}:${g.pos?.col} ${g.message}`;
      }
      return 'no error';
    };
    expect(at('let s = "abc')).toBe('1:9 unterminated string');
    // The '"' after b starts a new string inside the interpolation; that one is unterminated.
    expect(at('"a {b"')).toBe('1:6 unterminated string');
    expect(at('x = "a\\qb"')).toBe("1:7 invalid escape sequence '\\q'");
    expect(at('a $ b')).toBe("1:3 unexpected character '$'");
    expect(at('12abc')).toBe("1:1 invalid number '12a'");
  });
});
