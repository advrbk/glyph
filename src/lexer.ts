// Hand-written lexer. It turns source text into a flat token array.
//
// String interpolation is handled here rather than in the parser: when a
// string reaches an unescaped '{', the lexer emits the text so far as a
// `strStart` (or `strMid`) token and lexes ordinary tokens until the matching
// '}', then resumes the string. A stack of brace depths makes nested braces
// and nested strings inside an interpolation work: "a {f({x: 1})} b".

import { GlyphError, type Pos } from './errors.js';

export type TokType = 'num' | 'str' | 'strStart' | 'strMid' | 'strEnd' | 'ident' | 'kw' | 'punct' | 'eof';

export interface Token {
  type: TokType;
  /** Raw text for identifiers, keywords and punctuation. */
  text: string;
  /** Cooked contents for string tokens (escapes already applied). */
  value: string;
  /** Numeric value for number tokens. */
  num: number;
  line: number;
  col: number;
  /** True when a line break separates this token from the previous one. */
  nl: boolean;
}

export const KEYWORDS = new Set([
  'let', 'const', 'fn', 'return', 'if', 'else', 'while', 'for', 'in', 'break',
  'continue', 'true', 'false', 'nil', 'and', 'or', 'not', 'do',
]);

// Longest first, so '..=' wins over '..' and '++=' over '++'.
const PUNCT = [
  '..=', '++=',
  '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '=>', '|>', '..', '++',
  '(', ')', '[', ']', '{', '}', ',', '.', ':', ';', '=', '<', '>', '+', '-', '*', '/', '%',
];

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '{': '{', '}': '}', '0': '\0' };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string | undefined) => c !== undefined && (isIdentStart(c) || isDigit(c));

interface OpenInterp {
  depth: number; // '{' seen inside the interpolation and not yet closed
  start: Pos; // where the string began, for "unterminated string"
}

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  const interps: OpenInterp[] = [];
  // Skip a UTF-8 byte order mark, which some Windows editors put at the start of a file.
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let col = 1;
  let nl = true;

  const advance = () => {
    if (src[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    i++;
  };

  const push = (type: TokType, text: string, value: string, num: number, at: Pos) => {
    toks.push({ type, text, value, num, line: at.line, col: at.col, nl });
    nl = false;
  };

  // Reads string characters up to the closing quote or the next '{'.
  // `first` is true right after the opening quote, false after an interpolation's '}'.
  const stringPart = (start: Pos, at: Pos, first: boolean) => {
    let out = '';
    for (;;) {
      const ch = src[i];
      if (ch === undefined || ch === '\n') throw new GlyphError('syntax', 'unterminated string', start);
      if (ch === '"') {
        advance();
        push(first ? 'str' : 'strEnd', '', out, 0, at);
        return;
      }
      if (ch === '{') {
        advance();
        push(first ? 'strStart' : 'strMid', '', out, 0, at);
        interps.push({ depth: 0, start });
        return;
      }
      if (ch === '\\') {
        const escPos = { line, col };
        advance();
        const e = src[i];
        const cooked = e === undefined ? undefined : ESCAPES[e];
        if (cooked === undefined) {
          if (e === undefined || e === '\n') throw new GlyphError('syntax', 'unterminated string', start);
          throw new GlyphError('syntax', `invalid escape sequence '\\${e}'`, escPos);
        }
        out += cooked;
        advance();
        continue;
      }
      out += ch;
      advance();
    }
  };

  for (;;) {
    // Whitespace and '#' comments.
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '\n') {
        nl = true;
        advance();
      } else if (ch === ' ' || ch === '\t' || ch === '\r') {
        advance();
      } else if (ch === '#') {
        while (i < src.length && src[i] !== '\n') advance();
      } else {
        break;
      }
    }

    const at = { line, col };
    if (i >= src.length) {
      const open = interps[interps.length - 1];
      if (open) throw new GlyphError('syntax', 'unterminated string', open.start);
      push('eof', '', '', 0, at);
      return toks;
    }

    const ch = src[i]!;

    if (isDigit(ch)) {
      let j = i;
      while (isDigit(src[j])) j++;
      if (src[j] === '.' && isDigit(src[j + 1])) {
        j++;
        while (isDigit(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (isDigit(src[k])) {
          j = k;
          while (isDigit(src[j])) j++;
        }
      }
      if (isIdentPart(src[j])) {
        throw new GlyphError('syntax', `invalid number '${src.slice(i, j + 1)}'`, at);
      }
      const text = src.slice(i, j);
      while (i < j) advance();
      push('num', text, '', Number(text), at);
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i;
      while (isIdentPart(src[j])) j++;
      const text = src.slice(i, j);
      while (i < j) advance();
      push(KEYWORDS.has(text) ? 'kw' : 'ident', text, '', 0, at);
      continue;
    }

    if (ch === '"') {
      advance();
      stringPart(at, at, true);
      continue;
    }

    const open = interps[interps.length - 1];
    if (ch === '}' && open && open.depth === 0) {
      interps.pop();
      advance();
      stringPart(open.start, at, false);
      continue;
    }

    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (p === undefined) {
      // Show the whole character, not half of a surrogate pair (emoji and the like).
      const whole = String.fromCodePoint(src.codePointAt(i)!);
      throw new GlyphError('syntax', `unexpected character '${whole}'`, at);
    }
    if (open) {
      if (p === '{') open.depth++;
      else if (p === '}') open.depth--;
    }
    for (let k = 0; k < p.length; k++) advance();
    push('punct', p, '', 0, at);
  }
}
