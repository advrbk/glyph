// The tree-walking reference interpreter. It is deliberately simple and
// independent of the compiler: it ignores the resolver's slot and capture
// annotations and keeps variables in a chain of environments looked up by name.
// Closures capture the environment they were created in; a loop body gets a
// new environment on every iteration, which is what gives each iteration its
// own copy of the loop variable.
//
// It exists to be obviously correct, so the bytecode VM can be checked against
// it on thousands of random programs.

import type { Block, Expr, FnExpr, Stmt } from './ast.js';
import { GlyphError, hostLimitError, isJsStackOverflow, type Pos } from './errors.js';
import * as ops from './ops.js';
import { BUILTINS, callPlain, checkNativeArity } from './stdlib.js';
import {
  aType, display, GFunction, GMap, GRange, Native, truthy, UNINIT,
  type NativeContext, type Value,
} from './values.js';

type Cell = Value | typeof UNINIT;

class Env {
  readonly vars = new Map<string, Cell>();
  constructor(readonly parent: Env | null) {}
}

export class TreeFunction extends GFunction {
  constructor(
    readonly node: FnExpr,
    readonly env: Env,
  ) {
    super();
  }

  get name(): string | null {
    return this.node.name;
  }
}

class ReturnSignal {
  constructor(readonly value: Value) {}
}
const BREAK = { signal: 'break' };
const CONTINUE = { signal: 'continue' };

/** Thrown when a run uses up its evaluation budget. */
export class OutOfFuel extends Error {
  constructor() {
    super('out of fuel');
  }
}

const BUILTIN_BY_NAME = new Map(BUILTINS.map((b) => [b.name, b]));

function at<T>(pos: Pos, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof GlyphError && e.pos === null) e.pos = pos;
    throw e;
  }
}

export interface InterpreterOptions {
  out?: (line: string) => void;
  /** Maximum number of expression evaluations before giving up. */
  fuel?: number;
  /** Give up (as if out of fuel) after this performance.now() time. */
  deadline?: number;
}

export class Interpreter {
  private readonly ctx: NativeContext;
  private fuel: number;
  private readonly deadline: number;
  private depth = 1; // the script itself counts as one frame, as in the VM
  readonly globals = new Env(null);

  constructor(opts: InterpreterOptions = {}) {
    const out = opts.out ?? ((line: string) => console.log(line));
    this.ctx = { out };
    this.fuel = opts.fuel ?? Infinity;
    this.deadline = opts.deadline ?? Infinity;
  }

  /** Run a whole program; returns the value of its last expression statement. */
  run(program: Block): Value {
    try {
      return this.statements(program, this.globals);
    } catch (e) {
      // Deep recursion inside a Glyph call is reported by call(). Running out of
      // JS stack outside any call (very deeply nested expressions in a small stack,
      // such as a browser's) is reported here instead of escaping as a JS error.
      if (isJsStackOverflow(e)) throw new GlyphError('runtime', 'stack overflow (the tree-walker ran out of JavaScript stack)', null);
      throw e;
    }
  }

  // ---- environments -------------------------------------------------------

  private hoist(b: Block, env: Env): void {
    for (const s of b.stmts) {
      if (s.kind === 'Let' || s.kind === 'FnDecl') env.vars.set(s.name, UNINIT);
    }
  }

  private lookup(name: string, env: Env, pos: Pos): Value {
    for (let e: Env | null = env; e; e = e.parent) {
      const v = e.vars.get(name);
      if (v === undefined) continue;
      if (v === UNINIT) throw new GlyphError('runtime', ops.uninitMessage(name), pos);
      return v;
    }
    const b = BUILTIN_BY_NAME.get(name);
    if (b) return b;
    throw new Error(`internal: unresolved name ${name}`);
  }

  private assignVar(name: string, value: Value, env: Env, pos: Pos): void {
    for (let e: Env | null = env; e; e = e.parent) {
      const v = e.vars.get(name);
      if (v === undefined) continue;
      if (v === UNINIT) throw new GlyphError('runtime', ops.uninitMessage(name), pos);
      e.vars.set(name, value);
      return;
    }
    throw new Error(`internal: unresolved assignment to ${name}`);
  }

  // ---- blocks and statements ----------------------------------------------

  /** Run a block's statements in `env` (already created by the caller). */
  private statements(b: Block, env: Env): Value {
    this.hoist(b, env);
    let last: Value = null;
    const n = b.stmts.length;
    for (let i = 0; i < n; i++) {
      const s = b.stmts[i]!;
      if (s.kind === 'ExprStmt') {
        const v = this.eval(s.expr, env);
        last = i === n - 1 ? v : null;
      } else {
        this.exec(s, env);
        last = null;
      }
    }
    return last;
  }

  private block(b: Block, env: Env): Value {
    return this.statements(b, new Env(env));
  }

  private exec(s: Stmt, env: Env): void {
    switch (s.kind) {
      case 'Let':
        env.vars.set(s.name, s.init ? this.eval(s.init, env) : null);
        return;
      case 'FnDecl':
        env.vars.set(s.name, new TreeFunction(s.fn, env));
        return;
      case 'Return':
        throw new ReturnSignal(s.value ? this.eval(s.value, env) : null);
      case 'Break':
        throw BREAK;
      case 'Continue':
        throw CONTINUE;
      case 'While':
        while (truthy(this.eval(s.cond, env))) {
          try {
            this.block(s.body, env);
          } catch (e) {
            if (e === BREAK) break;
            if (e === CONTINUE) continue;
            throw e;
          }
        }
        return;
      case 'For': {
        const src = this.eval(s.iterable, env);
        const body = (item: Value): boolean => {
          const loopEnv = new Env(env);
          loopEnv.vars.set(s.name, item);
          try {
            this.block(s.body, loopEnv);
          } catch (e) {
            if (e === BREAK) return false;
            if (e === CONTINUE) return true;
            throw e;
          }
          return true;
        };
        if (Array.isArray(src)) {
          for (let i = 0; i < src.length; i++) if (!body(src[i]!)) break;
        } else if (src instanceof GRange) {
          for (let i = src.start; i < src.stop; i++) if (!body(i)) break;
        } else if (typeof src === 'string') {
          for (let i = 0; i < src.length; i++) if (!body(src[i]!)) break;
        } else if (src instanceof GMap) {
          for (const k of [...src.entries.keys()]) if (!body(k)) break;
        } else {
          throw new GlyphError('runtime', `cannot loop over ${aType(src)}`, s.pos);
        }
        return;
      }
      case 'ExprStmt':
        this.eval(s.expr, env);
        return;
    }
  }

  // ---- expressions --------------------------------------------------------

  eval(e: Expr, env: Env): Value {
    if (--this.fuel < 0) throw new OutOfFuel();
    // The deadline is only for the fuzzer; look at the clock every 4096 steps.
    if (this.deadline !== Infinity && (this.fuel & 4095) === 0 && performance.now() > this.deadline) throw new OutOfFuel();
    try {
      switch (e.kind) {
        case 'Num':
        case 'Str':
        case 'Bool':
          return e.value;
        case 'Nil':
          return null;
        case 'Ident':
          return this.lookup(e.name, env, e.pos);
        case 'Binary': {
          const a = this.eval(e.left, env);
          const b = this.eval(e.right, env);
          return ops.binary(e.op, a, b);
        }
        case 'Logical': {
          const a = this.eval(e.left, env);
          if (e.op === 'and') return truthy(a) ? this.eval(e.right, env) : a;
          return truthy(a) ? a : this.eval(e.right, env);
        }
        case 'Unary': {
          const v = this.eval(e.operand, env);
          return e.op === 'not' ? !truthy(v) : ops.negate(v);
        }
        case 'Call': {
          const callee = this.eval(e.callee, env);
          const args: Value[] = [];
          for (const a of e.args) args.push(this.eval(a, env));
          return this.call(callee, args, e.pos);
        }
        case 'If':
          if (truthy(this.eval(e.cond, env))) return this.statements(e.then, new Env(env));
          if (!e.else) return null;
          return e.else.kind === 'If' ? this.eval(e.else, env) : this.statements(e.else, new Env(env));
        case 'Block':
          return this.statements(e, new Env(env));
        case 'Index': {
          const obj = this.eval(e.object, env);
          return ops.getIndex(obj, this.eval(e.index, env));
        }
        case 'Field':
          return ops.getField(this.eval(e.object, env), e.name);
        case 'Fn':
          return new TreeFunction(e, env);
        case 'Assign':
          return this.assign(e, env);
        default:
          return this.evalOther(e, env);
      }
    } catch (x) {
      // Errors from operators and helpers carry no position; this node raised them.
      // (Errors from deeper nodes already have one and pass through unchanged.)
      if (x instanceof GlyphError) {
        if (x.pos === null) x.pos = e.pos;
        throw x;
      }
      // A string or array too long for JavaScript, raised by this node.
      const limit = hostLimitError(x);
      if (limit) {
        limit.pos = e.pos;
        throw limit;
      }
      throw x;
    }
  }

  /** The less common expression kinds, kept out of eval() to keep its stack frame small. */
  private evalOther(e: Expr, env: Env): Value {
    switch (e.kind) {
      case 'Interp': {
        let s = '';
        for (const p of e.parts) s += typeof p === 'string' ? p : display(this.eval(p, env));
        return s;
      }
      case 'Array': {
        const items: Value[] = [];
        for (const x of e.items) items.push(this.eval(x, env));
        return items;
      }
      case 'Map': {
        const pairs: Value[] = [];
        for (const en of e.entries) {
          pairs.push(typeof en.key === 'string' ? en.key : this.eval(en.key, env));
          pairs.push(this.eval(en.value, env));
        }
        return ops.buildMap(pairs);
      }
      case 'Range':
        return ops.makeRange(this.eval(e.start, env), this.eval(e.end, env), e.inclusive);
      default:
        throw new Error(`internal: unexpected node ${e.kind}`);
    }
  }

  private assign(e: Extract<Expr, { kind: 'Assign' }>, env: Env): Value {
    const t = e.target;
    const op = e.op === '=' ? null : e.op.slice(0, -1);
    const combine = (old: Value, v: Value) => (op === null ? v : at(e.pos, () => ops.binary(op, old, v)));
    if (t.kind === 'Ident') {
      const old = op === null ? null : this.lookup(t.name, env, t.pos);
      const v = combine(old, this.eval(e.value, env));
      this.assignVar(t.name, v, env, t.pos);
      return v;
    }
    if (t.kind === 'Index') {
      const obj = this.eval(t.object, env);
      const i = this.eval(t.index, env);
      const old = op === null ? null : at(t.pos, () => ops.getIndex(obj, i));
      const v = combine(old, this.eval(e.value, env));
      return at(t.pos, () => ops.setIndex(obj, i, v));
    }
    const obj = this.eval(t.object, env);
    const old = op === null ? null : at(t.pos, () => ops.getField(obj, t.name));
    const v = combine(old, this.eval(e.value, env));
    return at(t.pos, () => ops.setField(obj, t.name, v));
  }

  /** Call any callable value; `pos` is the call site, used for errors raised by the call itself. */
  call(callee: Value, args: Value[], pos: Pos): Value {
    if (callee instanceof TreeFunction) {
      const f = callee.node;
      if (f.params.length !== args.length) {
        throw new GlyphError('runtime', ops.arityMessage(f.name, f.params.length, args.length), pos);
      }
      if (this.depth >= ops.MAX_CALL_DEPTH) throw new GlyphError('runtime', ops.STACK_OVERFLOW, pos);
      // Parameters and the body's own declarations share one environment.
      // That is safe: a name the body declares is hoisted over the whole body,
      // so it hides a parameter of the same name everywhere in the body anyway.
      const env = new Env(callee.env);
      for (let i = 0; i < args.length; i++) env.vars.set(f.params[i]!.name, args[i]!);
      this.depth++;
      try {
        return this.statements(f.body, env);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value;
        // This interpreter recurses on the JS stack. If that runs out before the
        // Glyph call limit, report it the same way the VM reports deep recursion.
        // (Only a real stack overflow: other RangeErrors are not deep recursion.)
        if (isJsStackOverflow(e)) throw new GlyphError('runtime', ops.STACK_OVERFLOW, pos);
        throw e;
      } finally {
        this.depth--;
      }
    }
    if (callee instanceof Native) {
      if (callee.impl) return at(pos, () => callPlain(callee, args, this.ctx));
      at(pos, () => checkNativeArity(callee, args.length));
      if (this.depth >= ops.MAX_CALL_DEPTH) throw new GlyphError('runtime', ops.STACK_OVERFLOW, pos);
      this.depth++;
      try {
        const gen = callee.gen!(args, this.ctx);
        let input: Value = null;
        for (;;) {
          const step = at(pos, () => gen.next(input));
          if (step.done) return step.value;
          const [fn, fnArgs] = step.value;
          // Errors raised by the callback call itself (arity, not callable) point at the native's call site.
          input = this.call(fn, fnArgs, pos);
        }
      } finally {
        this.depth--;
      }
    }
    throw new GlyphError('runtime', ops.notCallable(callee), pos);
  }
}

