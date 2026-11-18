// Compiler: resolved AST -> bytecode.
//
// Stack layout of a call frame (slot numbers are relative to the frame base):
//
//   [callee] [arg0 = slot 0] [arg1 = slot 1] ... [locals] [temporaries]
//
// Locals are not pushed when their 'let' runs. Instead, when a block starts,
// every name the block declares gets its slot reserved up front (a nil, or a
// fresh box for a captured variable). 'let x = e' then just stores into the
// slot. Reserving early is what lets a closure capture a variable that is
// declared later in the same block (mutual recursion between local functions).
//
// Because blocks are expressions ('1 + do { let t = 2; t }'), locals can sit
// above temporaries, so the compiler tracks the exact stack depth after every
// instruction instead of just counting locals. Each emit adjusts `depth` by the
// instruction's stack effect, and every block checks that it leaves the stack
// exactly one value higher (expression) or unchanged (statement).
//
// Captured variables live in boxes (one heap cell per variable). The slot holds
// the box, closures copy the box reference when they are created, and every
// read or write of that variable goes through the box. A loop body is a fresh
// block on each iteration, so each iteration gets a fresh box: closures made
// in different iterations see different variables.

import type { Assign, Block, Expr, FnExpr, Ident, IfExpr, Stmt } from './ast.js';
import { FnProto, Op, type Program } from './bytecode.js';
import { GlyphError, guardDepth, type Pos } from './errors.js';
import type { Decl, FnInfo, GlobalScope } from './resolver.js';
import type { Value } from './values.js';

const BINARY: Record<string, Op> = {
  '+': Op.ADD, '-': Op.SUB, '*': Op.MUL, '/': Op.DIV, '%': Op.MOD, '++': Op.CONCAT,
  '==': Op.EQ, '!=': Op.NE, '<': Op.LT, '<=': Op.LE, '>': Op.GT, '>=': Op.GE,
};

interface Loop {
  start: number; // where 'continue' jumps back to
  depth: number; // stack depth to pop down to before leaving or restarting
  breaks: number[]; // jumps to patch to the loop exit
}

class FnState {
  readonly proto: FnProto;
  readonly code: number[] = [];
  depth = 0;
  readonly loops: Loop[] = [];
  readonly constKeys = new Map<string, number>();

  constructor(
    readonly info: FnInfo,
    name: string | null,
    arity: number,
  ) {
    this.proto = new FnProto(name, arity);
  }
}

export function compileProgram(program: Block, script: FnInfo, globals: GlobalScope): Program {
  const c = new Compiler(script);
  return { main: guardDepth('compile', () => c.script(program)), globalNames: globals.names.slice() };
}

function internal(msg: string): never {
  throw new Error(`internal compiler error: ${msg}`);
}

class Compiler {
  private f: FnState;

  constructor(script: FnInfo) {
    this.f = new FnState(script, '<script>', 0);
  }

  script(program: Block): FnProto {
    this.block(program, 'value');
    this.op(Op.RETURN, program.pos, -1);
    return this.finish(this.f);
  }

  // ---- emitting -----------------------------------------------------------

  private op(o: Op, pos: Pos, effect: number): void {
    const f = this.f;
    f.proto.positions[f.code.length] = pos;
    f.code.push(o);
    f.depth += effect;
    if (f.depth > f.proto.maxStack) f.proto.maxStack = f.depth;
  }

  private u8(n: number, pos: Pos, what: string): void {
    if (n < 0 || n > 255) throw new GlyphError('compile', `too many ${what} (the limit is 255)`, pos);
    this.f.code.push(n);
  }

  private u16(n: number, pos: Pos, what: string): void {
    if (n < 0 || n > 0xffff) throw new GlyphError('compile', `too many ${what} (the limit is 65535)`, pos);
    this.f.code.push(n >> 8, n & 0xff);
  }

  private jump(o: Op, pos: Pos, effect: number): number {
    this.op(o, pos, effect);
    this.f.code.push(0xff, 0xff);
    return this.f.code.length - 2;
  }

  private patch(at: number): void {
    const code = this.f.code;
    const offset = code.length - (at + 2);
    if (offset > 0xffff) throw new GlyphError('compile', 'function body is too large to jump over', null);
    code[at] = offset >> 8;
    code[at + 1] = offset & 0xff;
  }

  private loopBack(start: number, pos: Pos): void {
    this.op(Op.LOOP, pos, 0);
    const offset = this.f.code.length + 2 - start;
    this.u16(offset, pos, 'bytes in one loop');
  }

  private constant(v: Value | FnProto, pos: Pos): number {
    const f = this.f;
    let key: string | null = null;
    if (typeof v === 'number') key = Object.is(v, -0) ? 'n:-0' : `n:${v}`;
    else if (typeof v === 'string') key = `s:${v}`;
    if (key !== null) {
      const hit = f.constKeys.get(key);
      if (hit !== undefined) return hit;
    }
    const idx = f.proto.constants.length;
    if (idx > 0xffff) throw new GlyphError('compile', 'too many constants in one function (the limit is 65536)', pos);
    f.proto.constants.push(v);
    if (key !== null) f.constKeys.set(key, idx);
    return idx;
  }

  private pushConst(v: Value, pos: Pos): void {
    const idx = this.constant(v, pos);
    this.op(Op.CONST, pos, 1);
    this.u16(idx, pos, 'constants');
  }

  private popN(n: number, pos: Pos): void {
    while (n > 0) {
      const k = Math.min(n, 255);
      if (k === 1) {
        this.op(Op.POP, pos, -1);
      } else {
        this.op(Op.POPN, pos, -k);
        this.u8(k, pos, 'values');
      }
      n -= k;
    }
  }

  private popUnder(n: number, pos: Pos): void {
    while (n > 0) {
      const k = Math.min(n, 255);
      this.op(Op.POP_UNDER, pos, -k);
      this.u8(k, pos, 'values');
      n -= k;
    }
  }

  private finish(f: FnState): FnProto {
    f.proto.code = Uint8Array.from(f.code);
    return f.proto;
  }

  // ---- variables ----------------------------------------------------------

  private claimSlot(d: Decl, slot: number, pos: Pos): void {
    if (slot > 255) throw new GlyphError('compile', 'too many local variables in one function (the limit is 256)', pos);
    d.slot = slot;
    this.f.proto.slotNames[slot] = d.name;
  }

  private load(id: Ident): void {
    if (id.builtin !== undefined) {
      this.op(Op.GET_BUILTIN, id.pos, 1);
      this.u8(id.builtin, id.pos, 'builtins');
      return;
    }
    const d = id.decl ?? internal(`unresolved name ${id.name}`);
    if (d.global) {
      this.op(Op.GET_GLOBAL, id.pos, 1);
      this.u16(d.globalIndex, id.pos, 'global variables');
    } else if (d.fn === this.f.info) {
      this.op(d.captured ? Op.GET_BOX : Op.GET_LOCAL, id.pos, 1);
      this.u8(d.slot, id.pos, 'local variables');
    } else {
      this.op(Op.GET_CAPTURED, id.pos, 1);
      this.u8(this.captureIndex(d), id.pos, 'captured variables');
    }
  }

  /** 'set' leaves the value on the stack (assignment is an expression); 'init' pops it. */
  private store(d: Decl, pos: Pos, mode: 'set' | 'init'): void {
    if (d.global) {
      this.op(mode === 'set' ? Op.SET_GLOBAL : Op.DEFINE_GLOBAL, pos, mode === 'set' ? 0 : -1);
      this.u16(d.globalIndex, pos, 'global variables');
    } else if (d.fn === this.f.info) {
      const o = d.captured
        ? mode === 'set' ? Op.SET_BOX : Op.INIT_BOX
        : mode === 'set' ? Op.SET_LOCAL : Op.INIT_LOCAL;
      this.op(o, pos, mode === 'set' ? 0 : -1);
      this.u8(d.slot, pos, 'local variables');
    } else {
      if (mode === 'init') internal('initialising a captured variable');
      this.op(Op.SET_CAPTURED, pos, 0);
      this.u8(this.captureIndex(d), pos, 'captured variables');
    }
  }

  private captureIndex(d: Decl): number {
    return this.f.info.captureIndex.get(d) ?? internal(`variable ${d.name} not captured`);
  }

  // ---- blocks and statements ----------------------------------------------

  private block(b: Block, mode: 'value' | 'stmt'): void {
    const start = this.f.depth;
    let reserved = 0;
    for (const d of b.decls ?? internal('block was not resolved')) {
      if (d.global) continue;
      this.claimSlot(d, this.f.depth, b.pos);
      this.op(d.captured ? Op.PUSH_BOX : Op.NIL, b.pos, 1);
      reserved++;
    }
    let valueLeft = false;
    const n = b.stmts.length;
    for (let i = 0; i < n; i++) {
      const s = b.stmts[i]!;
      if (s.kind === 'ExprStmt') {
        this.expr(s.expr);
        if (i === n - 1 && mode === 'value') valueLeft = true;
        else this.op(Op.POP, s.pos, -1);
      } else {
        this.stmt(s);
      }
    }
    if (mode === 'value') {
      if (!valueLeft) this.op(Op.NIL, b.pos, 1);
      this.popUnder(reserved, b.pos);
    } else {
      this.popN(reserved, b.pos);
    }
    if (this.f.depth !== start + (mode === 'value' ? 1 : 0)) internal('stack depth mismatch after block');
  }

  private stmt(s: Stmt): void {
    const f = this.f;
    switch (s.kind) {
      case 'Let':
        if (s.init) this.expr(s.init);
        else this.op(Op.NIL, s.pos, 1);
        this.store(s.decl ?? internal('let not resolved'), s.pos, 'init');
        return;
      case 'FnDecl':
        this.fn(s.fn, s.name);
        this.store(s.decl ?? internal('fn not resolved'), s.pos, 'init');
        return;
      case 'Return': {
        const depth = f.depth;
        if (s.value) this.expr(s.value);
        else this.op(Op.NIL, s.pos, 1);
        this.op(Op.RETURN, s.pos, -1);
        f.depth = depth; // the code after a return is unreachable
        return;
      }
      case 'Break':
      case 'Continue': {
        const loop = f.loops[f.loops.length - 1] ?? internal('break outside loop');
        const depth = f.depth;
        this.popN(depth - loop.depth, s.pos);
        if (s.kind === 'Break') loop.breaks.push(this.jump(Op.JUMP, s.pos, 0));
        else this.loopBack(loop.start, s.pos);
        f.depth = depth;
        return;
      }
      case 'While': {
        const depth = f.depth;
        const start = f.code.length;
        this.expr(s.cond);
        const exit = this.jump(Op.JUMP_IF_FALSE, s.pos, -1);
        f.loops.push({ start, depth, breaks: [] });
        this.block(s.body, 'stmt');
        this.loopBack(start, s.pos);
        this.patch(exit);
        for (const b of f.loops.pop()!.breaks) this.patch(b);
        return;
      }
      case 'For': {
        this.expr(s.iterable);
        this.op(Op.ITER_INIT, s.pos, 0);
        const iterDepth = f.depth; // the iterator stays on the stack as a hidden local
        const start = f.code.length;
        const exit = this.jump(Op.ITER_NEXT, s.pos, 1); // pushes the next item = the loop variable
        const d = s.decl ?? internal('for not resolved');
        this.claimSlot(d, f.depth - 1, s.namePos);
        if (d.captured) {
          this.op(Op.BOX_SLOT, s.namePos, 0);
          this.u8(d.slot, s.namePos, 'local variables');
        }
        f.loops.push({ start, depth: iterDepth, breaks: [] });
        this.block(s.body, 'stmt');
        this.op(Op.POP, s.pos, -1); // the loop variable
        this.loopBack(start, s.pos);
        this.patch(exit);
        for (const b of f.loops.pop()!.breaks) this.patch(b);
        f.depth = iterDepth;
        this.op(Op.POP, s.pos, -1); // the iterator
        return;
      }
      case 'ExprStmt':
        this.expr(s.expr);
        this.op(Op.POP, s.pos, -1);
        return;
    }
  }

  // ---- expressions ----------------------------------------------------------

  private expr(e: Expr): void {
    switch (e.kind) {
      case 'Num':
      case 'Str':
        this.pushConst(e.value, e.pos);
        return;
      case 'Bool':
        this.op(e.value ? Op.TRUE : Op.FALSE, e.pos, 1);
        return;
      case 'Nil':
        this.op(Op.NIL, e.pos, 1);
        return;
      case 'Interp': {
        let n = 0;
        for (const p of e.parts) {
          if (typeof p === 'string') {
            if (p === '') continue;
            this.pushConst(p, e.pos);
          } else {
            this.expr(p);
          }
          n++;
        }
        if (n === 0) {
          this.pushConst('', e.pos);
          return;
        }
        this.op(Op.INTERP, e.pos, 1 - n);
        this.u8(n, e.pos, 'parts in one string');
        return;
      }
      case 'Ident':
        this.load(e);
        return;
      case 'Array':
        for (const x of e.items) this.expr(x);
        this.op(Op.ARRAY, e.pos, 1 - e.items.length);
        this.u16(e.items.length, e.pos, 'array items');
        return;
      case 'Map':
        for (const en of e.entries) {
          if (typeof en.key === 'string') this.pushConst(en.key, e.pos);
          else this.expr(en.key);
          this.expr(en.value);
        }
        this.op(Op.MAP, e.pos, 1 - 2 * e.entries.length);
        this.u16(e.entries.length, e.pos, 'map entries');
        return;
      case 'Unary':
        this.expr(e.operand);
        this.op(e.op === '-' ? Op.NEG : Op.NOT, e.pos, 0);
        return;
      case 'Binary':
        this.expr(e.left);
        this.expr(e.right);
        this.op(BINARY[e.op]!, e.pos, -1);
        return;
      case 'Logical': {
        this.expr(e.left);
        const end = this.jump(e.op === 'and' ? Op.JUMP_IF_FALSE_KEEP : Op.JUMP_IF_TRUE_KEEP, e.pos, 0);
        this.op(Op.POP, e.pos, -1);
        this.expr(e.right);
        this.patch(end);
        return;
      }
      case 'Range':
        this.expr(e.start);
        this.expr(e.end);
        this.op(e.inclusive ? Op.RANGE_INCL : Op.RANGE, e.pos, -1);
        return;
      case 'Assign':
        this.assign(e);
        return;
      case 'Call':
        this.expr(e.callee);
        for (const a of e.args) this.expr(a);
        this.op(Op.CALL, e.pos, -e.args.length);
        this.u8(e.args.length, e.pos, 'arguments');
        return;
      case 'Index':
        this.expr(e.object);
        this.expr(e.index);
        this.op(Op.GET_INDEX, e.pos, -1);
        return;
      case 'Field':
        this.expr(e.object);
        this.op(Op.GET_FIELD, e.pos, 0);
        this.u16(this.constant(e.name, e.pos), e.pos, 'constants');
        return;
      case 'Fn':
        this.fn(e, e.name);
        return;
      case 'If':
        this.ifExpr(e);
        return;
      case 'Block':
        this.block(e, 'value');
        return;
    }
  }

  private ifExpr(e: IfExpr): void {
    this.expr(e.cond);
    const toElse = this.jump(Op.JUMP_IF_FALSE, e.pos, -1);
    const depth = this.f.depth;
    this.block(e.then, 'value');
    const toEnd = this.jump(Op.JUMP, e.pos, 0);
    this.patch(toElse);
    this.f.depth = depth;
    if (!e.else) this.op(Op.NIL, e.pos, 1);
    else if (e.else.kind === 'If') this.ifExpr(e.else);
    else this.block(e.else, 'value');
    this.patch(toEnd);
  }

  private assign(e: Assign): void {
    const t = e.target;
    const op = e.op === '=' ? null : BINARY[e.op.slice(0, -1)]!;
    if (t.kind === 'Ident') {
      if (op !== null) this.load(t);
      this.expr(e.value);
      if (op !== null) this.op(op, e.pos, -1);
      this.store(t.decl ?? internal('assignment target not resolved'), t.pos, 'set');
    } else if (t.kind === 'Index') {
      this.expr(t.object);
      this.expr(t.index);
      if (op !== null) {
        this.op(Op.DUP2, t.pos, 2);
        this.op(Op.GET_INDEX, t.pos, -1);
      }
      this.expr(e.value);
      if (op !== null) this.op(op, e.pos, -1);
      this.op(Op.SET_INDEX, t.pos, -2);
    } else {
      const name = this.constant(t.name, t.pos);
      this.expr(t.object);
      if (op !== null) {
        this.op(Op.DUP, t.pos, 1);
        this.op(Op.GET_FIELD, t.pos, 0);
        this.u16(name, t.pos, 'constants');
      }
      this.expr(e.value);
      if (op !== null) this.op(op, e.pos, -1);
      this.op(Op.SET_FIELD, t.pos, -1);
      this.u16(name, t.pos, 'constants');
    }
  }

  private fn(fn: FnExpr, name: string | null): void {
    const info = fn.info ?? internal('function not resolved');
    const parent = this.f;
    const child = new FnState(info, name, fn.params.length);
    if (fn.params.length > 255) throw new GlyphError('compile', 'too many parameters (the limit is 255)', fn.pos);
    this.f = child;
    child.depth = fn.params.length;
    child.proto.maxStack = child.depth;
    const params = fn.paramDecls ?? internal('params not resolved');
    params.forEach((d, i) => {
      this.claimSlot(d, i, d.pos);
      if (d.captured) {
        this.op(Op.BOX_SLOT, d.pos, 0);
        this.u8(i, d.pos, 'local variables');
      }
    });
    for (const d of info.captures) child.proto.captureNames.push(d.name);
    this.block(fn.body, 'value');
    this.op(Op.RETURN, fn.body.pos, -1);
    const proto = this.finish(child);
    this.f = parent;

    const idx = this.constant(proto, fn.pos);
    this.op(Op.CLOSURE, fn.pos, 1);
    this.u16(idx, fn.pos, 'constants');
    for (const d of info.captures) {
      if (d.fn === parent.info) {
        this.f.code.push(1);
        this.u8(d.slot, fn.pos, 'local variables');
      } else {
        this.f.code.push(0);
        this.u8(this.captureIndex(d), fn.pos, 'captured variables');
      }
    }
  }
}
