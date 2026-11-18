// Constant folding, the one optimisation pass. It runs on the resolved AST and
// returns a new tree (the input is not modified, so the same parse can be
// compiled with and without folding).
//
// What it does:
//  * evaluates operators whose operands are literals: 2 * 3.5, "a" ++ "b",
//    not true, -(4), 1 < 2;
//  * replaces a reference to a constant whose value is a literal
//    (const RATE = 0.25) with that literal, so const RATE * 4 folds to 1;
//  * merges literal parts of string interpolations;
//  * drops the dead branch of an if with a literal condition, and simplifies
//    'and' / 'or' with a literal left side.
//
// What it must never do is change behaviour. So an operation that would raise
// an error (1 / 0, "a" + 1) is left alone and still fails at run time, at the
// same position. It also never reassociates arithmetic: x * 2 * 3 is (x * 2) * 3
// and stays that way, because floating point is not associative.

import { isLiteral, type Block, type Expr, type FnExpr, type IfExpr, type Literal, type Stmt } from './ast.js';
import type { Pos } from './errors.js';
import { GlyphError } from './errors.js';
import { binary, negate } from './ops.js';
import { display, truthy, type Value } from './values.js';

const MAX_FOLDED_STRING = 1024;

export interface FoldStats {
  folds: number;
}

export function foldProgram(program: Block, stats: FoldStats = { folds: 0 }): Block {
  return new Folder(stats).block(program);
}

function toLiteral(v: Value, pos: Pos): Literal | null {
  if (typeof v === 'number') return { kind: 'Num', value: v, pos };
  if (typeof v === 'string') return v.length <= MAX_FOLDED_STRING ? { kind: 'Str', value: v, pos } : null;
  if (typeof v === 'boolean') return { kind: 'Bool', value: v, pos };
  if (v === null) return { kind: 'Nil', pos };
  return null;
}

function valueOf(l: Literal): Value {
  return l.kind === 'Nil' ? null : l.value;
}

/** Run an operator at compile time; null if it would fail (leave that for run time). */
function attempt(f: () => Value, pos: Pos): Literal | null {
  try {
    return toLiteral(f(), pos);
  } catch (e) {
    if (e instanceof GlyphError) return null;
    throw e;
  }
}

class Folder {
  constructor(private readonly stats: FoldStats) {}

  block(b: Block): Block {
    return { ...b, stmts: b.stmts.map((s) => this.stmt(s)) };
  }

  private fn(f: FnExpr): FnExpr {
    return { ...f, body: this.block(f.body) };
  }

  private stmt(s: Stmt): Stmt {
    switch (s.kind) {
      case 'Let': {
        const init = s.init ? this.expr(s.init) : null;
        if (s.constant && init && isLiteral(init) && s.decl) s.decl.constValue = init;
        return { ...s, init };
      }
      case 'FnDecl':
        return { ...s, fn: this.fn(s.fn) };
      case 'Return':
        return s.value ? { ...s, value: this.expr(s.value) } : s;
      case 'While':
        return { ...s, cond: this.expr(s.cond), body: this.block(s.body) };
      case 'For':
        return { ...s, iterable: this.expr(s.iterable), body: this.block(s.body) };
      case 'ExprStmt':
        return { ...s, expr: this.expr(s.expr) };
      case 'Break':
      case 'Continue':
        return s;
    }
  }

  private hit<T>(x: T): T {
    this.stats.folds++;
    return x;
  }

  expr(e: Expr): Expr {
    switch (e.kind) {
      case 'Num': case 'Str': case 'Bool': case 'Nil':
        return e;
      case 'Ident': {
        const c = e.decl?.constValue;
        // Only references after the declaration: a forward reference from a
        // closure may run before the constant exists and must still fail.
        if (c && e.afterDef) return this.hit({ ...c, pos: e.pos });
        return e;
      }
      case 'Interp': {
        const parts: (string | Expr)[] = [];
        let changed = false;
        for (const p of e.parts) {
          const q = typeof p === 'string' ? p : this.expr(p);
          if (typeof q !== 'string' && isLiteral(q)) {
            parts.push(display(valueOf(q)));
            changed = true;
          } else {
            parts.push(q);
          }
        }
        // Merge neighbouring text.
        const merged: (string | Expr)[] = [];
        for (const p of parts) {
          const last = merged[merged.length - 1];
          if (typeof p === 'string' && typeof last === 'string') merged[merged.length - 1] = last + p;
          else merged.push(p);
        }
        if (merged.length === 1 && typeof merged[0] === 'string' && merged[0].length <= MAX_FOLDED_STRING) {
          return this.hit({ kind: 'Str', value: merged[0], pos: e.pos });
        }
        if (changed) this.stats.folds++;
        return { ...e, parts: merged };
      }
      case 'Array':
        return { ...e, items: e.items.map((x) => this.expr(x)) };
      case 'Map':
        return {
          ...e,
          entries: e.entries.map((en) => ({
            key: typeof en.key === 'string' ? en.key : this.expr(en.key),
            value: this.expr(en.value),
          })),
        };
      case 'Unary': {
        const operand = this.expr(e.operand);
        if (isLiteral(operand)) {
          const v = valueOf(operand);
          const r = e.op === 'not' ? toLiteral(!truthy(v), e.pos) : attempt(() => negate(v), e.pos);
          if (r) return this.hit(r);
        }
        return { ...e, operand };
      }
      case 'Binary': {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        if (isLiteral(left) && isLiteral(right)) {
          const r = attempt(() => binary(e.op, valueOf(left), valueOf(right)), e.pos);
          if (r) return this.hit(r);
        }
        return { ...e, left, right };
      }
      case 'Logical': {
        const left = this.expr(e.left);
        const right = this.expr(e.right);
        if (isLiteral(left)) {
          const t = truthy(valueOf(left));
          // 'a and b' is a when a is falsy, else b. 'a or b' is a when a is truthy, else b.
          return this.hit(e.op === 'and' ? (t ? right : left) : t ? left : right);
        }
        return { ...e, left, right };
      }
      case 'Range':
        return { ...e, start: this.expr(e.start), end: this.expr(e.end) };
      case 'Assign': {
        const t = e.target;
        const target = t.kind === 'Ident'
          ? t
          : t.kind === 'Index'
            ? { ...t, object: this.expr(t.object), index: this.expr(t.index) }
            : { ...t, object: this.expr(t.object) };
        return { ...e, target, value: this.expr(e.value) };
      }
      case 'Call':
        return { ...e, callee: this.expr(e.callee), args: e.args.map((a) => this.expr(a)) };
      case 'Index':
        return { ...e, object: this.expr(e.object), index: this.expr(e.index) };
      case 'Field':
        return { ...e, object: this.expr(e.object) };
      case 'Fn':
        return this.fn(e);
      case 'If':
        return this.ifExpr(e);
      case 'Block':
        return this.block(e);
    }
  }

  private ifExpr(e: IfExpr): Expr {
    const cond = this.expr(e.cond);
    if (isLiteral(cond)) {
      this.stats.folds++;
      if (truthy(valueOf(cond))) return this.block(e.then);
      if (!e.else) return { kind: 'Nil', pos: e.pos };
      return e.else.kind === 'If' ? this.ifExpr(e.else) : this.block(e.else);
    }
    let otherwise: Block | IfExpr | null = null;
    if (e.else) {
      // A folded 'else if' becomes a block, an if, or nil (when no branch is taken).
      const f = e.else.kind === 'If' ? this.ifExpr(e.else) : this.block(e.else);
      otherwise = f.kind === 'Block' || f.kind === 'If' ? f : null;
    }
    return { ...e, cond, then: this.block(e.then), else: otherwise };
  }
}
