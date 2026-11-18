// The bytecode VM: a stack machine with an explicit frame stack.
//
// The value stack is one JS array shared by all frames. A frame is a window on
// it starting at `base` (slot 0). The current frame's code, ip, base and the
// stack pointer live in local variables of run() for speed and are written
// back to the frame object whenever control leaves the frame.
//
// run(budget) executes at most `budget` instructions and can be called again
// to continue, which is how the playground steps through a program and how the
// fuzzer bounds runaway programs.

import type { FnProto, Program } from './bytecode.js';
import { GlyphError, type Pos, fail, hostLimitError } from './errors.js';
import * as ops from './ops.js';
import { BUILTINS, callPlain, checkNativeArity } from './stdlib.js';
import {
  aType, display, equals, GFunction, GMap, GRange, Native, UNINIT,
  type CallRequest, type NativeContext, type Value,
} from './values.js';

type Slot = Value | Box | Iter | typeof UNINIT;

/** A heap cell holding one captured variable. */
export class Box {
  constructor(public v: Value | typeof UNINIT) {}
}

export class Closure extends GFunction {
  constructor(
    readonly proto: FnProto,
    readonly caps: Box[],
  ) {
    super();
  }

  get name(): string | null {
    return this.proto.name;
  }
}

/** Iterator state for 'for x in ...'; lives in a hidden stack slot. */
export class Iter {
  i = 0;
  constructor(
    readonly src: Value[] | GRange | string,
    readonly keys: string[] | null,
  ) {}
}

export class Frame {
  ip = 0;
  constructor(
    readonly closure: Closure,
    readonly base: number,
  ) {}
}

/** A native (map/filter/reduce) waiting for a callback it asked for to return. */
export class NativeFrame {
  constructor(
    readonly native: Native,
    readonly gen: Generator<CallRequest, Value, Value>,
    readonly pos: Pos | null,
  ) {}
}

export type VMStatus = 'ready' | 'paused' | 'done' | 'error';

export interface VMOptions {
  out?: (line: string) => void;
}

const DONE = Symbol('done');
// Module-local copies of imports used on hot paths. Some loaders (tsx, test
// runners) turn every imported binding into a getter call; a local const is
// just a variable read.
const UN: typeof UNINIT = UNINIT;


function makeIter(v: Value): Iter {
  if (Array.isArray(v) || v instanceof GRange || typeof v === 'string') return new Iter(v, null);
  if (v instanceof GMap) return new Iter([], [...v.entries.keys()]);
  fail(`cannot loop over ${aType(v)}`);
}

function iterNext(it: Iter): Value | typeof DONE {
  if (it.keys) return it.i < it.keys.length ? it.keys[it.i++]! : DONE;
  const s = it.src;
  if (s instanceof GRange) {
    const v = s.start + it.i;
    if (v >= s.stop) return DONE;
    it.i++;
    return v;
  }
  if (it.i >= s.length) return DONE;
  return s[it.i++]!;
}

export class VM {
  readonly stack: Slot[] = [];
  sp = 0;
  readonly frames: (Frame | NativeFrame)[] = [];
  readonly globals: (Value | typeof UNINIT)[] = [];
  globalNames: string[] = [];
  status: VMStatus = 'ready';
  result: Value = null;
  error: GlyphError | null = null;
  /** Instructions executed so far. */
  steps = 0;
  private readonly ctx: NativeContext;

  constructor(opts: VMOptions = {}) {
    const out = opts.out ?? ((line: string) => console.log(line));
    this.ctx = { out };
  }

  /** Prepare to run a program. Globals from earlier programs (the REPL) are kept. */
  load(program: Program): void {
    while (this.globals.length < program.globalNames.length) this.globals.push(UNINIT);
    this.globalNames = program.globalNames;
    this.sp = 0;
    this.frames.length = 0;
    const main = new Closure(program.main, []);
    this.stack[this.sp++] = main;
    this.frames.push(new Frame(main, this.sp));
    this.status = 'paused';
    this.error = null;
    this.result = null;
  }

  /** Current source position (for the debugger). */
  currentPos(): Pos | null {
    const f = this.frames[this.frames.length - 1];
    if (!f) return null;
    if (f instanceof NativeFrame) return f.pos;
    return f.closure.proto.positions[f.ip] ?? null;
  }

  /**
   * Execute up to `budget` instructions. Returns the status afterwards:
   * 'done', 'paused' (budget used up) or 'error' (this.error is set).
   */
  run(budget = Infinity): VMStatus {
    if (this.status !== 'paused') return this.status;
    const stack = this.stack;
    const frames = this.frames;
    const globals = this.globals;

    let frame = frames[frames.length - 1] as Frame;
    let proto = frame.closure.proto;
    let code = proto.code;
    let consts = proto.constants;
    let caps = frame.closure.caps;
    let ip = frame.ip;
    let base = frame.base;
    let sp = this.sp;
    let start = ip;
    let executed = 0;


    try {
      while (executed < budget) {
        executed++;
        start = ip;
        switch (code[ip++]) {
          case 0 /* CONST */:
            stack[sp++] = consts[(code[ip]! << 8) | code[ip + 1]!] as Value;
            ip += 2;
            break;
          case 1 /* NIL */:
            stack[sp++] = null;
            break;
          case 2 /* TRUE */:
            stack[sp++] = true;
            break;
          case 3 /* FALSE */:
            stack[sp++] = false;
            break;
          case 4 /* POP */:
            sp--;
            break;
          case 5 /* POPN */:
            sp -= code[ip++]!;
            break;
          case 6 /* POP_UNDER */: {
            const v = stack[sp - 1];
            sp -= code[ip++]!;
            stack[sp - 1] = v;
            break;
          }
          case 7 /* DUP */:
            stack[sp] = stack[sp - 1];
            sp++;
            break;
          case 8 /* DUP2 */:
            stack[sp] = stack[sp - 2];
            stack[sp + 1] = stack[sp - 1];
            sp += 2;
            break;

          case 9 /* PUSH_BOX */:
            stack[sp++] = new Box(UN);
            break;
          case 10 /* GET_LOCAL */:
            stack[sp++] = stack[base + code[ip++]!];
            break;
          case 11 /* SET_LOCAL */:
            stack[base + code[ip++]!] = stack[sp - 1];
            break;
          case 12 /* INIT_LOCAL */:
            stack[base + code[ip++]!] = stack[--sp];
            break;
          case 13 /* GET_BOX */:
            stack[sp++] = (stack[base + code[ip++]!] as Box).v;
            break;
          case 14 /* SET_BOX */:
            (stack[base + code[ip++]!] as Box).v = stack[sp - 1] as Value;
            break;
          case 15 /* INIT_BOX */:
            (stack[base + code[ip++]!] as Box).v = stack[--sp] as Value;
            break;
          case 16 /* BOX_SLOT */: {
            const s = base + code[ip++]!;
            stack[s] = new Box(stack[s] as Value);
            break;
          }
          case 17 /* GET_CAPTURED */: {
            const i = code[ip++]!;
            const v = caps[i]!.v;
            if (v === UN) fail(ops.uninitMessage(proto.captureNames[i]!));
            stack[sp++] = v;
            break;
          }
          case 18 /* SET_CAPTURED */: {
            const i = code[ip++]!;
            const b = caps[i]!;
            if (b.v === UN) fail(ops.uninitMessage(proto.captureNames[i]!));
            b.v = stack[sp - 1] as Value;
            break;
          }
          case 19 /* GET_GLOBAL */: {
            const g = (code[ip]! << 8) | code[ip + 1]!;
            ip += 2;
            const v = globals[g];
            if (v === UN) fail(ops.uninitMessage(this.globalNames[g]!));
            stack[sp++] = v as Value;
            break;
          }
          case 20 /* SET_GLOBAL */: {
            const g = (code[ip]! << 8) | code[ip + 1]!;
            ip += 2;
            if (globals[g] === UN) fail(ops.uninitMessage(this.globalNames[g]!));
            globals[g] = stack[sp - 1] as Value;
            break;
          }
          case 21 /* DEFINE_GLOBAL */: {
            const g = (code[ip]! << 8) | code[ip + 1]!;
            ip += 2;
            globals[g] = stack[--sp] as Value;
            break;
          }
          case 22 /* GET_BUILTIN */:
            stack[sp++] = BUILTINS[code[ip++]!]!;
            break;

          case 23 /* ADD */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a + b : ops.add(a, b);
            break;
          }
          case 24 /* SUB */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a - b : ops.sub(a, b);
            break;
          }
          case 25 /* MUL */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a * b : ops.mul(a, b);
            break;
          }
          case 26 /* DIV */: {
            const b = stack[--sp] as Value;
            stack[sp - 1] = ops.div(stack[sp - 1] as Value, b);
            break;
          }
          case 27 /* MOD */: {
            const b = stack[--sp] as Value;
            stack[sp - 1] = ops.mod(stack[sp - 1] as Value, b);
            break;
          }
          case 28 /* CONCAT */: {
            const b = stack[--sp] as Value;
            stack[sp - 1] = ops.concat(stack[sp - 1] as Value, b);
            break;
          }
          case 29 /* NEG */: {
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' ? -a : ops.negate(a);
            break;
          }
          case 30 /* NOT */:
            {
              const v = stack[sp - 1];
              stack[sp - 1] = v === false || v === null;
            }
            break;
          case 31 /* EQ */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = a === b || equals(a, b);
            break;
          }
          case 32 /* NE */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = a !== b && !equals(a, b);
            break;
          }
          case 33 /* LT */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a < b : ops.compare('<', a, b);
            break;
          }
          case 34 /* LE */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a <= b : ops.compare('<=', a, b);
            break;
          }
          case 35 /* GT */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a > b : ops.compare('>', a, b);
            break;
          }
          case 36 /* GE */: {
            const b = stack[--sp] as Value;
            const a = stack[sp - 1] as Value;
            stack[sp - 1] = typeof a === 'number' && typeof b === 'number' ? a >= b : ops.compare('>=', a, b);
            break;
          }
          case 37 /* RANGE */:
          case 38 /* RANGE_INCL */: {
            const b = stack[--sp] as Value;
            stack[sp - 1] = ops.makeRange(stack[sp - 1] as Value, b, code[start] === 38 /* RANGE_INCL */);
            break;
          }

          case 39 /* JUMP */:
            ip += ((code[ip]! << 8) | code[ip + 1]!) + 2;
            break;
          case 40 /* JUMP_IF_FALSE */: {
            const v = stack[--sp];
            if (v === false || v === null) ip += ((code[ip]! << 8) | code[ip + 1]!) + 2;
            else ip += 2;
            break;
          }
          case 41 /* JUMP_IF_FALSE_KEEP */: {
            const v = stack[sp - 1];
            if (v === false || v === null) ip += ((code[ip]! << 8) | code[ip + 1]!) + 2;
            else ip += 2;
            break;
          }
          case 42 /* JUMP_IF_TRUE_KEEP */: {
            const v = stack[sp - 1];
            if (v !== false && v !== null) ip += ((code[ip]! << 8) | code[ip + 1]!) + 2;
            else ip += 2;
            break;
          }
          case 43 /* LOOP */:
            ip = ip + 2 - ((code[ip]! << 8) | code[ip + 1]!);
            break;

          case 44 /* CALL */: {
            const argc = code[ip++]!;
            const callee = stack[sp - argc - 1] as Value;
            if (callee instanceof Closure) {
              if (callee.proto.arity !== argc) fail(ops.arityMessage(callee.proto.name, callee.proto.arity, argc));
              if (frames.length >= ops.MAX_CALL_DEPTH) fail(ops.STACK_OVERFLOW);
              frame.ip = ip;
              frame = new Frame(callee, sp - argc);
              frames.push(frame);
              proto = callee.proto;
              code = proto.code;
              consts = proto.constants;
              caps = callee.caps;
              ip = 0;
              base = frame.base;
            } else if (callee instanceof Native) {
              const args = stack.slice(sp - argc, sp) as Value[];
              sp -= argc + 1;
              if (callee.impl) {
                stack[sp++] = callPlain(callee, args, this.ctx);
              } else {
                frame.ip = ip;
                this.sp = sp;
                this.startNative(callee, args, proto.positions[start] ?? null);
                // Switch the registers to whatever frame is on top now.
                frame = frames[frames.length - 1] as Frame;
                proto = frame.closure.proto;
                code = proto.code;
                consts = proto.constants;
                caps = frame.closure.caps;
                ip = frame.ip;
                base = frame.base;
                sp = this.sp;
              }
            } else {
              fail(ops.notCallable(callee));
            }
            break;
          }
          case 45 /* RETURN */: {
            const result = stack[sp - 1] as Value;
            sp = base - 1; // drops the callee, the arguments and the locals
            frames.pop();
            const top = frames[frames.length - 1];
            if (top instanceof Frame) {
              // Fast path: return into a Glyph function.
              stack[sp++] = result;
            } else {
              // The script finished, or a native (map/filter/reduce) gets the result.
              this.sp = sp;
              this.deliver(result);
              if ((this.status as VMStatus) === 'done') return this.finishRun(executed);
              sp = this.sp;
            }
            frame = frames[frames.length - 1] as Frame;
            proto = frame.closure.proto;
            code = proto.code;
            consts = proto.constants;
            caps = frame.closure.caps;
            ip = frame.ip;
            base = frame.base;
            break;
          }
          case 46 /* CLOSURE */: {
            const p = consts[(code[ip]! << 8) | code[ip + 1]!] as FnProto;
            ip += 2;
            const n = p.captureNames.length;
            const boxes: Box[] = new Array(n);
            for (let i = 0; i < n; i++) {
              const local = code[ip++] === 1;
              const idx = code[ip++]!;
              boxes[i] = local ? (stack[base + idx] as Box) : caps[idx]!;
            }
            stack[sp++] = new Closure(p, boxes);
            break;
          }

          case 47 /* ARRAY */: {
            const n = (code[ip]! << 8) | code[ip + 1]!;
            ip += 2;
            const items = stack.slice(sp - n, sp) as Value[];
            sp -= n;
            stack[sp++] = items;
            break;
          }
          case 48 /* MAP */: {
            const n = (code[ip]! << 8) | code[ip + 1]!;
            ip += 2;
            const pairs = stack.slice(sp - 2 * n, sp) as Value[];
            sp -= 2 * n;
            stack[sp++] = ops.buildMap(pairs);
            break;
          }
          case 49 /* GET_INDEX */: {
            const i = stack[--sp] as Value;
            stack[sp - 1] = ops.getIndex(stack[sp - 1] as Value, i);
            break;
          }
          case 50 /* SET_INDEX */: {
            const v = stack[--sp] as Value;
            const i = stack[--sp] as Value;
            stack[sp - 1] = ops.setIndex(stack[sp - 1] as Value, i, v);
            break;
          }
          case 51 /* GET_FIELD */: {
            const name = consts[(code[ip]! << 8) | code[ip + 1]!] as string;
            ip += 2;
            stack[sp - 1] = ops.getField(stack[sp - 1] as Value, name);
            break;
          }
          case 52 /* SET_FIELD */: {
            const name = consts[(code[ip]! << 8) | code[ip + 1]!] as string;
            ip += 2;
            const v = stack[--sp] as Value;
            stack[sp - 1] = ops.setField(stack[sp - 1] as Value, name, v);
            break;
          }
          case 53 /* INTERP */: {
            const n = code[ip++]!;
            let s = '';
            for (let i = sp - n; i < sp; i++) s += display(stack[i] as Value);
            sp -= n;
            stack[sp++] = s;
            break;
          }
          case 54 /* ITER_INIT */:
            stack[sp - 1] = makeIter(stack[sp - 1] as Value);
            break;
          case 55 /* ITER_NEXT */: {
            const v = iterNext(stack[sp - 1] as Iter);
            if (v === DONE) {
              ip += ((code[ip]! << 8) | code[ip + 1]!) + 2;
            } else {
              ip += 2;
              stack[sp++] = v;
            }
            break;
          }
          default:
            throw new Error(`bad opcode ${code[start]} at ${start}`);
        }
      }
      frame.ip = ip;
      this.sp = sp;
      return this.finishRun(executed);
    } catch (thrown) {
      // A string or array too long for JavaScript is a runtime error like any other.
      const e = thrown instanceof GlyphError ? thrown : hostLimitError(thrown);
      if (!e) throw thrown;
      if (e.pos === null) {
        const top = frames[frames.length - 1];
        e.pos = top instanceof NativeFrame ? top.pos : frame.closure.proto.positions[start] ?? null;
      }
      frame.ip = start;
      this.sp = sp;
      this.error = e;
      this.status = 'error';
      return this.finishRun(executed);
    }
  }

  private finishRun(executed: number): VMStatus {
    this.steps += executed;
    return this.status;
  }

  private pushFrame(f: Frame | NativeFrame): void {
    if (this.frames.length >= ops.MAX_CALL_DEPTH) fail(ops.STACK_OVERFLOW);
    this.frames.push(f);
  }

  /** Start a generator native; it may push a callback frame and return early. */
  private startNative(n: Native, args: Value[], pos: Pos | null): void {
    try {
      checkNativeArity(n, args.length);
    } catch (e) {
      throw withPos(e, pos);
    }
    const nf = new NativeFrame(n, n.gen!(args, this.ctx), pos);
    try {
      this.pushFrame(nf);
    } catch (e) {
      throw withPos(e, pos);
    }
    this.advance(nf, null);
  }

  /** Hand a finished frame's result to whatever is now on top of the frame stack. */
  private deliver(result: Value): void {
    const top = this.frames[this.frames.length - 1];
    if (top === undefined) {
      this.result = result;
      this.status = 'done';
      return;
    }
    if (top instanceof NativeFrame) {
      this.advance(top, result);
      return;
    }
    this.stack[this.sp++] = result;
  }

  /**
   * Resume a native with a callback's result. It either finishes (its result is
   * delivered to the frame below) or asks for another call. A call to a Glyph
   * function pushes a normal frame and returns to the dispatch loop.
   */
  private advance(nf: NativeFrame, input: Value): void {
    for (;;) {
      let step: IteratorResult<CallRequest, Value>;
      try {
        step = nf.gen.next(input);
      } catch (e) {
        throw withPos(e, nf.pos);
      }
      if (step.done) {
        this.frames.pop();
        this.deliver(step.value);
        return;
      }
      const [callee, args] = step.value;
      try {
        if (callee instanceof Closure) {
          if (callee.proto.arity !== args.length) fail(ops.arityMessage(callee.proto.name, callee.proto.arity, args.length));
          const stack = this.stack;
          stack[this.sp++] = callee;
          for (const a of args) stack[this.sp++] = a;
          this.pushFrame(new Frame(callee, this.sp - args.length));
          return;
        }
        if (callee instanceof Native) {
          if (callee.impl) {
            input = callPlain(callee, args, this.ctx);
            continue;
          }
          checkNativeArity(callee, args.length);
          const inner = new NativeFrame(callee, callee.gen!(args, this.ctx), nf.pos);
          this.pushFrame(inner);
          nf = inner;
          input = null;
          continue;
        }
        fail(ops.notCallable(callee));
      } catch (e) {
        throw withPos(e, nf.pos);
      }
    }
  }
}

function withPos(e: unknown, pos: Pos | null): unknown {
  if (e instanceof GlyphError && e.pos === null) e.pos = pos;
  return e;
}

