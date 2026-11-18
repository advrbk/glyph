// Pratt parser. Each token that can start an expression has a "prefix" rule
// (prefix()); each token that can continue one has a binding power
// (infixPower()). parseExpr(minPower) keeps folding infix operators into the
// left operand while their power is at least minPower. Left-associative
// operators parse their right side with power + 1, right-associative ones
// (assignment) with the same power.
//
// Line breaks matter in exactly two places: a statement must end at a line
// break, ';' or '}', and '(', '[' or '-' at the start of a line begin a new
// statement instead of calling, indexing or subtracting from the previous line.
// Any other operator at the start of a line continues the previous line, which
// is handy for long pipelines ("|> filter(...)").

import type {
  AssignOp, BinaryOp, Block, Expr, FnExpr, IfExpr, MapEntry, Stmt,
} from './ast.js';
import { GlyphError, type Pos } from './errors.js';
import { lex, type Token } from './lexer.js';

const enum P {
  None = 0,
  Assign = 1,
  Pipe = 2,
  Or = 3,
  And = 4,
  Equality = 5,
  Compare = 6,
  Range = 7,
  Concat = 8,
  Sum = 9,
  Product = 10,
  Unary = 11,
  Postfix = 12,
}


function infixPower(t: Token): P {
  if (t.type === 'kw') return t.text === 'or' ? P.Or : t.text === 'and' ? P.And : P.None;
  if (t.type !== 'punct') return P.None;
  switch (t.text) {
    case '=': case '+=': case '-=': case '*=': case '/=': case '%=': case '++=':
      return P.Assign;
    case '|>': return P.Pipe;
    case '==': case '!=': return P.Equality;
    case '<': case '<=': case '>': case '>=': return P.Compare;
    case '..': case '..=': return P.Range;
    case '++': return P.Concat;
    case '+': return P.Sum;
    // '-' can also start an expression, so on a new line it starts a new statement.
    case '-': return t.nl ? P.None : P.Sum;
    case '*': case '/': case '%': return P.Product;
    case '(': case '[': return t.nl ? P.None : P.Postfix;
    case '.': return P.Postfix;
    default: return P.None;
  }
}

function describe(t: Token): string {
  switch (t.type) {
    case 'eof': return 'end of input';
    case 'num': return `number ${t.text}`;
    case 'str': case 'strStart': return 'a string';
    case 'strMid': case 'strEnd': return "'}'";
    case 'ident': return `'${t.text}'`;
    default: return `'${t.text}'`;
  }
}

export function parse(source: string): Block {
  return new Parser(lex(source)).program();
}

class Parser {
  private i = 0;

  constructor(private readonly toks: Token[]) {}

  // ---- token helpers ------------------------------------------------------

  private peek(): Token {
    return this.toks[this.i]!;
  }

  private next(): Token {
    const t = this.toks[this.i]!;
    if (t.type !== 'eof') this.i++;
    return t;
  }

  private is(text: string): boolean {
    const t = this.peek();
    return (t.type === 'punct' || t.type === 'kw') && t.text === text;
  }

  private eat(text: string): boolean {
    if (this.is(text)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(text: string, context: string): Token {
    if (this.is(text)) return this.next();
    const t = this.peek();
    throw this.error(`expected '${text}' ${context}, found ${describe(t)}`, t);
  }

  private ident(context: string): Token {
    const t = this.peek();
    if (t.type === 'ident') return this.next();
    if (t.type === 'kw') throw this.error(`'${t.text}' is a keyword and cannot be used as a name`, t);
    throw this.error(`expected a name ${context}, found ${describe(t)}`, t);
  }

  private error(message: string, at: Token | Pos): GlyphError {
    return new GlyphError('syntax', message, { line: at.line, col: at.col });
  }

  private pos(t: Token): Pos {
    return { line: t.line, col: t.col };
  }

  // ---- statements ---------------------------------------------------------

  program(): Block {
    const stmts = this.statements('eof');
    return { kind: 'Block', stmts, pos: { line: 1, col: 1 } };
  }

  private statements(end: '}' | 'eof'): Stmt[] {
    const stmts: Stmt[] = [];
    const atEnd = () => (end === 'eof' ? this.peek().type === 'eof' : this.is('}') || this.peek().type === 'eof');
    while (!atEnd()) {
      if (this.eat(';')) continue;
      stmts.push(this.statement());
      const t = this.peek();
      if (!(atEnd() || this.is(';') || t.nl)) {
        throw this.error(`expected a new line or ';' before ${describe(t)}`, t);
      }
    }
    return stmts;
  }

  private block(context: string): Block {
    const open = this.expect('{', context);
    const stmts = this.statements('}');
    if (this.peek().type === 'eof') {
      // Point at the brace that was never closed, not at the end of the file.
      throw this.error("this '{' is never closed (reached the end of input)", open);
    }
    this.expect('}', 'to close the block');
    return { kind: 'Block', stmts, pos: this.pos(open) };
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.type === 'kw') {
      switch (t.text) {
        case 'let':
        case 'const': {
          this.next();
          const constant = t.text === 'const';
          const name = this.ident(`after '${t.text}'`);
          let init: Expr | null = null;
          if (this.eat('=')) init = this.expr();
          else if (constant) throw this.error(`constant '${name.text}' needs a value`, this.peek());
          return { kind: 'Let', name: name.text, constant, init, pos: this.pos(name) };
        }
        case 'fn': {
          const after = this.toks[this.i + 1];
          if (after && after.type === 'ident') {
            this.next();
            const name = this.next();
            const fn = this.fnRest(t, name.text);
            return { kind: 'FnDecl', name: name.text, fn, pos: this.pos(name) };
          }
          break;
        }
        case 'return': {
          this.next();
          const n = this.peek();
          const bare = n.type === 'eof' || n.nl || this.is('}') || this.is(';');
          return { kind: 'Return', value: bare ? null : this.expr(), pos: this.pos(t) };
        }
        case 'break':
          this.next();
          return { kind: 'Break', pos: this.pos(t) };
        case 'continue':
          this.next();
          return { kind: 'Continue', pos: this.pos(t) };
        case 'while': {
          this.next();
          const cond = this.expr();
          const body = this.block("to start the loop body");
          return { kind: 'While', cond, body, pos: this.pos(t) };
        }
        case 'for': {
          this.next();
          const name = this.ident("after 'for'");
          this.expect('in', 'after the loop variable');
          const iterable = this.expr();
          const body = this.block('to start the loop body');
          return { kind: 'For', name: name.text, namePos: this.pos(name), iterable, body, pos: this.pos(t) };
        }
      }
    }
    const expr = this.expr();
    return { kind: 'ExprStmt', expr, pos: expr.pos };
  }

  // ---- expressions --------------------------------------------------------

  expr(minPower: P = P.Assign): Expr {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const power = infixPower(t);
      if (power === P.None || power < minPower) return left;
      this.next();
      const pos = this.pos(t);
      switch (power) {
        case P.Assign: {
          if (left.kind !== 'Ident' && left.kind !== 'Index' && left.kind !== 'Field') {
            throw this.error('invalid assignment target', t);
          }
          const value = this.expr(P.Assign);
          left = { kind: 'Assign', op: t.text as AssignOp, target: left, value, pos };
          break;
        }
        case P.Pipe: {
          // a |> f(b, c) is exactly f(a, b, c); a |> f is f(a).
          const rhs = this.expr(P.Pipe + 1);
          left = rhs.kind === 'Call'
            ? { ...rhs, args: [left, ...rhs.args] }
            : { kind: 'Call', callee: rhs, args: [left], pos };
          break;
        }
        case P.Or:
        case P.And: {
          const right = this.expr(power + 1);
          left = { kind: 'Logical', op: t.text as 'and' | 'or', left, right, pos };
          break;
        }
        case P.Equality:
        case P.Compare: {
          const right = this.expr(power + 1);
          left = { kind: 'Binary', op: t.text as BinaryOp, left, right, pos };
          const n = this.peek();
          if (infixPower(n) === power) {
            throw this.error(`comparisons cannot be chained; use 'and' to combine them`, n);
          }
          break;
        }
        case P.Range: {
          const end = this.expr(P.Range + 1);
          left = { kind: 'Range', start: left, end, inclusive: t.text === '..=', pos };
          if (infixPower(this.peek()) === P.Range) throw this.error('ranges cannot be chained', this.peek());
          break;
        }
        case P.Concat:
        case P.Sum:
        case P.Product: {
          const right = this.expr(power + 1);
          left = { kind: 'Binary', op: t.text as BinaryOp, left, right, pos };
          break;
        }
        case P.Postfix: {
          if (t.text === '(') {
            const args = this.list(')', 'arguments');
            left = { kind: 'Call', callee: left, args, pos };
          } else if (t.text === '[') {
            const index = this.expr();
            this.expect(']', 'after the index');
            left = { kind: 'Index', object: left, index, pos };
          } else {
            // Any name may follow '.', keywords included, because a map literal
            // accepts them as bare keys too: {if: 1}.if
            const name = this.peek().type === 'kw' ? this.next() : this.ident("after '.'");
            left = { kind: 'Field', object: left, name: name.text, pos: this.pos(name) };
          }
          break;
        }
      }
    }
  }

  /** Comma-separated expressions up to `close` (already past the opener). Trailing comma allowed. */
  private list(close: string, what: string): Expr[] {
    const items: Expr[] = [];
    while (!this.is(close)) {
      items.push(this.expr());
      if (!this.eat(',')) break;
    }
    this.expect(close, `after the ${what}`);
    return items;
  }

  private prefix(): Expr {
    const t = this.next();
    const pos = this.pos(t);
    switch (t.type) {
      case 'num':
        return { kind: 'Num', value: t.num, pos };
      case 'str':
        return { kind: 'Str', value: t.value, pos };
      case 'strStart':
        return this.interpolation(t);
      case 'ident':
        return { kind: 'Ident', name: t.text, pos };
      case 'kw':
        switch (t.text) {
          case 'true': return { kind: 'Bool', value: true, pos };
          case 'false': return { kind: 'Bool', value: false, pos };
          case 'nil': return { kind: 'Nil', pos };
          case 'not': return { kind: 'Unary', op: 'not', operand: this.expr(P.Unary), pos };
          case 'fn': {
            if (this.peek().type === 'ident') {
              throw this.error("a named function must be a statement; write 'fn(...)' for a function value", this.peek());
            }
            return this.fnRest(t, null);
          }
          case 'if': return this.ifRest(t);
          case 'do':
            return this.block("after 'do'");
        }
        break;
      case 'punct':
        switch (t.text) {
          case '-': return { kind: 'Unary', op: '-', operand: this.expr(P.Unary), pos };
          case '(': {
            const inner = this.expr();
            this.expect(')', 'to close the parenthesis');
            return inner;
          }
          case '[':
            return { kind: 'Array', items: this.list(']', 'array items'), pos };
          case '{':
            return this.mapRest(pos);
        }
        break;
    }
    throw this.error(`expected an expression, found ${describe(t)}`, t);
  }

  private interpolation(start: Token): Expr {
    const parts: (string | Expr)[] = [start.value];
    for (;;) {
      if (this.peek().type === 'strMid' || this.peek().type === 'strEnd') {
        throw this.error('empty interpolation; put an expression between { and }', this.peek());
      }
      parts.push(this.expr());
      const t = this.next();
      if (t.type === 'strMid') {
        parts.push(t.value);
      } else if (t.type === 'strEnd') {
        parts.push(t.value);
        break;
      } else {
        throw this.error(`expected '}' to close the interpolation, found ${describe(t)}`, t);
      }
    }
    return { kind: 'Interp', parts, pos: this.pos(start) };
  }

  private mapRest(pos: Pos): Expr {
    const entries: MapEntry[] = [];
    while (!this.is('}')) {
      const t = this.peek();
      let key: string | Expr;
      if (t.type === 'ident' || t.type === 'kw') {
        key = this.next().text;
      } else if (t.type === 'str') {
        key = this.next().value;
      } else if (this.eat('[')) {
        key = this.expr();
        this.expect(']', 'after the computed key');
      } else {
        throw this.error(`expected a map key (a name, a string or [expression]), found ${describe(t)}`, t);
      }
      this.expect(':', 'after the map key');
      entries.push({ key, value: this.expr() });
      if (!this.eat(',')) break;
    }
    this.expect('}', 'to close the map');
    return { kind: 'Map', entries, pos };
  }

  private fnRest(fnTok: Token, name: string | null): FnExpr {
    this.expect('(', 'to start the parameter list');
    const params: { name: string; pos: Pos }[] = [];
    while (!this.is(')')) {
      const p = this.ident('for a parameter');
      params.push({ name: p.text, pos: this.pos(p) });
      if (!this.eat(',')) break;
    }
    this.expect(')', 'after the parameters');
    let body: Block;
    if (this.is('=>')) {
      const arrow = this.next();
      const e = this.expr();
      body = { kind: 'Block', stmts: [{ kind: 'ExprStmt', expr: e, pos: e.pos }], pos: this.pos(arrow) };
    } else {
      body = this.block("or '=>' to start the function body");
    }
    return { kind: 'Fn', name, params, body, pos: this.pos(fnTok) };
  }

  private ifRest(ifTok: Token): IfExpr {
    const cond = this.expr();
    const then = this.block('after the if condition');
    let otherwise: Block | IfExpr | null = null;
    if (this.eat('else')) {
      if (this.is('if')) otherwise = this.ifRest(this.next());
      else otherwise = this.block("after 'else'");
    }
    return { kind: 'If', cond, then, else: otherwise, pos: this.pos(ifTok) };
  }
}
