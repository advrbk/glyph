// Random program generator for differential testing.
//
// It writes Glyph source text (so the lexer and parser are exercised too)
// that always passes the resolver: names are declared before use, constants
// are never assigned, break/continue only appear in loops and return only in
// functions. It tracks a rough static type for every variable so most
// programs run for a while and print a lot, and it deliberately mixes in
// operations that can fail at run time (index out of range, division by zero,
// a missing map key, the occasional wrong-typed operand) so the error paths are
// compared too.
//
// Every loop is bounded (ranges of a few items, while loops with a counter that
// is incremented first thing in the body) and recursion always counts down, so
// generated programs terminate. The harness still runs them with a fuel limit.

export class Rng {
  private s: number;

  constructor(seed: number) {
    // Mix the seed so that neighbouring seeds give unrelated streams.
    let x = (seed ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    this.s = (x ^ (x >>> 16)) >>> 0 || 1;
  }

  /** xorshift32 */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x;
  }

  int(n: number): number {
    return this.next() % n;
  }

  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() / 0x100000000 < p;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
}

type Ty = 'num' | 'str' | 'bool' | 'arr' | 'map' | 'fn';

interface Var {
  name: string;
  ty: Ty;
  mutable: boolean;
  arity?: number;
}

interface Ctx {
  scopes: Var[][];
  loop: boolean; // break/continue allowed
  fn: boolean; // return allowed
  depth: number; // statement nesting
  ownFrom: number; // index of the first scope that belongs to the current function
}

const STRINGS = ['"a"', '"xy"', '""', '"hello"', '"Glyph"', '"a b"', '"x\\ny"', '"q\\"t"', '"{}"'.replace('{}', '\\{\\}'), '"7"'];

export interface GenOptions {
  /** Approximate number of top-level statements. */
  statements?: number;
}

export function generateProgram(seed: number, opts: GenOptions = {}): string {
  return new Generator(new Rng(seed)).program(opts.statements ?? 20);
}

class Generator {
  private lines: string[] = [];
  private counter = 0;
  private budget = 0;

  constructor(private readonly r: Rng) {}

  program(n: number): string {
    this.budget = n * 4; // total statements, including nested ones
    const ctx: Ctx = { scopes: [[]], loop: false, fn: false, depth: 0, ownFrom: 0 };
    // Seed a few variables of each kind so expressions have material.
    this.emit(ctx, `let ${this.declare(ctx, 'num', true)} = ${this.r.range(0, 9)}`);
    this.emit(ctx, `let ${this.declare(ctx, 'str', true)} = ${this.r.pick(STRINGS)}`);
    this.emit(ctx, `let ${this.declare(ctx, 'arr', true)} = [${this.r.range(1, 5)}, ${this.r.range(0, 9)}, ${this.r.range(0, 3)}]`);
    this.emit(ctx, `let ${this.declare(ctx, 'map', true)} = {a: ${this.r.range(0, 9)}, b: ${this.r.range(1, 5)}}`);
    if (this.r.chance(0.08)) this.forwardReference(ctx);
    for (let i = 0; i < n && this.budget > 0; i++) this.stmt(ctx);
    this.emit(ctx, `print(${this.all(ctx).filter((v) => v.ty !== 'fn').map((v) => v.name).slice(0, 6).join(', ')})`);
    return this.lines.join('\n') + '\n';
  }

  // ---- bookkeeping ----------------------------------------------------------

  private fresh(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  private declare(ctx: Ctx, ty: Ty, mutable: boolean, arity?: number, name?: string): string {
    const v: Var = { name: name ?? this.fresh(ty === 'fn' ? 'f' : 'v'), ty, mutable, arity };
    ctx.scopes[ctx.scopes.length - 1]!.push(v);
    return v.name;
  }

  private all(ctx: Ctx): Var[] {
    // Innermost declaration wins when a name is shadowed.
    const seen = new Map<string, Var>();
    for (let i = ctx.scopes.length - 1; i >= 0; i--) {
      for (const v of ctx.scopes[i]!) if (!seen.has(v.name)) seen.set(v.name, v);
    }
    return [...seen.values()];
  }

  private vars(ctx: Ctx, ty: Ty, mutableOnly = false): Var[] {
    return this.all(ctx).filter((v) => v.ty === ty && (!mutableOnly || v.mutable));
  }

  private emit(ctx: Ctx, line: string): void {
    this.lines.push('  '.repeat(ctx.depth) + line);
  }

  private inner(ctx: Ctx, extra: Partial<Ctx> = {}): Ctx {
    const own = extra.fn ? ctx.scopes.length : ctx.ownFrom;
    return { scopes: [...ctx.scopes, []], loop: ctx.loop, fn: ctx.fn, depth: ctx.depth + 1, ownFrom: own, ...extra };
  }

  private body(ctx: Ctx, count: number): void {
    // Occasionally shadow an outer variable as the first statement of the block.
    if (this.r.chance(0.1)) {
      // Not loop counters: a while body starts with the counter's increment.
      const outer = this.all(ctx).filter((v) => v.ty === 'num' && v.mutable);
      if (outer.length) {
        const v = this.r.pick(outer);
        const hidden: Ctx = { ...ctx, scopes: ctx.scopes.map((s) => s.filter((w) => w.name !== v.name)) };
        const init = this.expr(hidden, 'num', 2);
        this.emit(ctx, `let ${v.name} = ${init}`);
        this.declare(ctx, 'num', true, undefined, v.name);
      }
    }
    for (let i = 0; i < count && this.budget > 0; i++) this.stmt(ctx);
  }

  // ---- statements -----------------------------------------------------------

  private stmt(ctx: Ctx): void {
    this.budget--;
    const r = this.r;
    const nest = ctx.depth < 3;
    const options: [number, () => void][] = [
      [6, () => this.letStmt(ctx)],
      [7, () => this.printStmt(ctx)],
      [6, () => this.assignStmt(ctx)],
      [nest ? 3 : 0, () => this.ifStmt(ctx)],
      [nest ? 2 : 0, () => this.whileStmt(ctx)],
      [nest ? 3 : 0, () => this.forStmt(ctx)],
      [nest ? 3 : 0, () => this.fnDecl(ctx)],
      [nest ? 1 : 0, () => this.recursiveFn(ctx)],
      [nest ? 1 : 0, () => this.loopClosures(ctx)],
      [nest ? 1 : 0, () => this.counterMaker(ctx)],
      [ctx.loop ? 2 : 0, () => this.emit(ctx, `if ${this.expr(ctx, 'bool', 1)} { ${r.chance(0.5) ? 'break' : 'continue'} }`)],
      // break/continue in the middle of an expression, with temporaries on the stack
      [ctx.loop ? 1 : 0, () => this.emit(ctx, `print(${this.expr(ctx, 'num', 1)}, ${this.expr(ctx, 'str', 1)} ++ if ${this.expr(ctx, 'bool', 1)} { ${r.chance(0.5) ? 'break' : 'continue'} } else { "ok" })`)],
      [ctx.fn ? 2 : 0, () => this.emit(ctx, `if ${this.expr(ctx, 'bool', 1)} { return ${this.expr(ctx, 'num', 1)} }`)],
      [2, () => this.callStmt(ctx)],
      [ctx.depth > 0 ? 0.3 : 0, () => this.forwardReference(ctx)],
      [1, () => this.evaluationOrder(ctx)],
    ];
    let total = 0;
    for (const [w] of options) total += w;
    let k = r.int(total);
    for (const [w, f] of options) {
      if (k < w) {
        f();
        return;
      }
      k -= w;
    }
  }

  private letStmt(ctx: Ctx): void {
    const ty = this.r.pick<Ty>(['num', 'num', 'str', 'bool', 'arr', 'map', 'fn']);
    const constant = ty === 'fn' || this.r.chance(0.3);
    const init = this.expr(ctx, ty, 3);
    const name = this.declare(ctx, ty, !constant, ty === 'fn' ? 1 : undefined);
    this.emit(ctx, `${constant ? 'const' : 'let'} ${name} = ${init}`);
  }

  private printStmt(ctx: Ctx): void {
    const n = this.r.range(1, 3);
    const args: string[] = [];
    for (let i = 0; i < n; i++) args.push(this.expr(ctx, this.anyTy(), 3));
    this.emit(ctx, `print(${args.join(', ')})`);
  }

  private anyTy(): Ty {
    return this.r.pick<Ty>(['num', 'num', 'num', 'str', 'str', 'bool', 'arr', 'map']);
  }

  private assignStmt(ctx: Ctx): void {
    const r = this.r;
    const ty = r.pick<Ty>(['num', 'num', 'str', 'arr', 'map', 'bool']);
    const vs = this.vars(ctx, ty, ty === 'num' || ty === 'str' || ty === 'bool');
    if (!vs.length) return this.letStmt(ctx);
    const v = r.pick(vs);
    switch (ty) {
      case 'num': {
        const op = r.pick(['=', '+=', '-=', '*=', '+=', '%=']);
        this.emit(ctx, `${v.name} ${op} ${this.expr(ctx, 'num', 2)}`);
        return;
      }
      case 'str':
        if (r.chance(0.6)) this.emit(ctx, `${v.name} ++= ${r.pick(STRINGS)}`);
        else this.emit(ctx, `${v.name} = ${this.leaf(ctx, 'str')}`);
        return;
      case 'bool':
        this.emit(ctx, `${v.name} = ${this.expr(ctx, 'bool', 2)}`);
        return;
      case 'arr':
        switch (r.int(3)) {
          case 0: {
            // Only push to arrays this function owns. A function that grows an
            // outer array could be called from a callback looping over it, and
            // that loop would never end.
            const own = ctx.scopes.slice(ctx.ownFrom).flat().filter((w) => w.ty === 'arr');
            if (!own.length) return this.letStmt(ctx);
            this.emit(ctx, `push(${r.pick(own).name}, ${this.expr(ctx, 'num', 2)})`);
            return;
          }
          case 1:
            this.emit(ctx, `${v.name}[${this.index(ctx, v.name)}] = ${this.expr(ctx, 'num', 2)}`);
            return;
          default:
            this.emit(ctx, `${v.name}[${this.index(ctx, v.name)}] ${r.pick(['+=', '*=', '-='])} ${this.expr(ctx, 'num', 1)}`);
            return;
        }
      case 'map':
        switch (r.int(3)) {
          case 0:
            this.emit(ctx, `${v.name}.${r.pick(['a', 'b', 'c'])} = ${this.expr(ctx, 'num', 2)}`);
            return;
          case 1:
            this.emit(ctx, `${v.name}.${r.pick(['a', 'b'])} += ${this.expr(ctx, 'num', 1)}`);
            return;
          default:
            this.emit(ctx, `${v.name}[${r.pick(['"a"', '"b"', '"z"'])}] = ${this.expr(ctx, 'num', 2)}`);
            return;
        }
    }
  }

  private index(ctx: Ctx, arr: string): string {
    const r = this.r;
    const k = r.int(20);
    if (k < 12) return '0';
    if (k < 16) return `len(${arr}) - 1`;
    if (k < 18) return '1';
    return `${this.expr(ctx, 'num', 1)} % 3`;
  }

  private ifStmt(ctx: Ctx): void {
    this.emit(ctx, `if ${this.expr(ctx, 'bool', 2)} {`);
    this.body(this.inner(ctx), this.r.range(1, 3));
    if (this.r.chance(0.3)) {
      this.emit(ctx, `} else if ${this.expr(ctx, 'bool', 2)} {`);
      this.body(this.inner(ctx), this.r.range(1, 2));
    }
    if (this.r.chance(0.5)) {
      this.emit(ctx, '} else {');
      this.body(this.inner(ctx), this.r.range(1, 3));
    }
    this.emit(ctx, '}');
  }

  private whileStmt(ctx: Ctx): void {
    const w = this.fresh('w');
    this.emit(ctx, `let ${w} = 0`);
    this.declare(ctx, 'num', false, undefined, w); // readable, but never assigned by generated code
    this.emit(ctx, `while ${w} < ${this.r.range(0, 5)} {`);
    const inner = this.inner(ctx, { loop: true });
    this.emit(inner, `${w} += 1`);
    this.body(inner, this.r.range(1, 3));
    this.emit(ctx, '}');
  }

  private forStmt(ctx: Ctx): void {
    const r = this.r;
    const x = this.fresh('i');
    let ty: Ty = 'num';
    let src: string;
    switch (r.int(6)) {
      case 0: {
        const a = r.range(-2, 3);
        src = `${a}..${a + r.range(0, 5)}`;
        break;
      }
      case 1:
        src = `${r.range(0, 2)}..=${r.range(0, 4)}`;
        break;
      case 2:
        // Never loop directly over an array variable: the body (or a function it
        // calls) may push to that array, and the loop would never end. A fresh
        // array from an expression cannot be reached from the body.
        src = `map(${this.expr(ctx, 'arr', 2)}, fn(x) => x)`;
        break;
      case 3:
        ty = 'str';
        src = r.pick(['"abc"', '"hi"', '""']);
        break;
      case 4: {
        const maps = this.vars(ctx, 'map');
        ty = 'str';
        src = maps.length ? r.pick(maps).name : '{k: 1, j: 2}';
        break;
      }
      default:
        src = `0..len(${this.expr(ctx, 'arr', 1)})`;
    }
    this.emit(ctx, `for ${x} in ${src} {`);
    const inner = this.inner(ctx, { loop: true });
    inner.scopes[inner.scopes.length - 1]!.push({ name: x, ty, mutable: false });
    this.body(inner, r.range(1, 3));
    this.emit(ctx, '}');
  }

  private fnDecl(ctx: Ctx): void {
    const r = this.r;
    const name = this.fresh('f');
    const arity = r.range(0, 2);
    const params = Array.from({ length: arity }, () => this.fresh('p'));
    // Declare first: the body may not call it (no unbounded recursion), so it
    // is added to the model only after the body is generated.
    const inner = this.inner(ctx, { loop: false, fn: true });
    for (const p of params) inner.scopes[inner.scopes.length - 1]!.push({ name: p, ty: 'num', mutable: true });
    if (r.chance(0.4)) {
      this.emit(ctx, `fn ${name}(${params.join(', ')}) => ${this.expr(inner, 'num', 3)}`);
    } else {
      this.emit(ctx, `fn ${name}(${params.join(', ')}) {`);
      this.body(inner, r.range(1, 4));
      this.emit(inner, this.expr(inner, 'num', 2));
      this.emit(ctx, '}');
    }
    this.declare(ctx, 'fn', false, arity, name);
    if (r.chance(0.7)) this.emit(ctx, `print(${this.callExpr(ctx, { name, ty: 'fn', mutable: false, arity }, 1)})`);
  }

  private recursiveFn(ctx: Ctx): void {
    const r = this.r;
    const name = this.fresh('r');
    const n = this.fresh('n');
    const inner = this.inner(ctx, { loop: false, fn: true });
    inner.scopes[inner.scopes.length - 1]!.push({ name: n, ty: 'num', mutable: false });
    const base = this.expr(ctx, 'num', 1);
    const step = this.expr(inner, 'num', 1);
    if (r.chance(0.5)) {
      this.emit(ctx, `fn ${name}(${n}) => if ${n} <= 0 { ${base} } else { ${step} + ${name}(${n} - 1) }`);
    } else {
      this.emit(ctx, `fn ${name}(${n}) {`);
      this.emit(inner, `if ${n} <= 0 { return ${base} }`);
      const acc = this.fresh('t');
      this.emit(inner, `let ${acc} = ${name}(${n} - 1)`);
      this.emit(inner, `${acc} * 2 - ${step}`);
      this.emit(ctx, '}');
    }
    this.declare(ctx, 'fn', false, 1, name);
    this.emit(ctx, `print(${name}(${r.range(0, 6)}))`);
  }

  /** Closures created in a loop must each see their own iteration's variables. */
  private loopClosures(ctx: Ctx): void {
    const r = this.r;
    const fs = this.fresh('fs');
    const i = this.fresh('i');
    this.emit(ctx, `let ${fs} = []`);
    if (r.chance(0.5)) {
      this.emit(ctx, `for ${i} in 0..${r.range(1, 4)} {`);
      const inner = this.inner(ctx, { loop: true });
      inner.scopes[inner.scopes.length - 1]!.push({ name: i, ty: 'num', mutable: false });
      const k = this.fresh('k');
      this.emit(inner, `let ${k} = ${i} * ${r.range(1, 5)}`);
      inner.scopes[inner.scopes.length - 1]!.push({ name: k, ty: 'num', mutable: true });
      const extra = this.expr(inner, 'num', 1);
      this.emit(inner, `push(${fs}, fn() => ${i} + ${k} + ${extra})`);
      if (r.chance(0.5)) this.emit(inner, `${k} += 100`);
      this.emit(ctx, '}');
    } else {
      this.emit(ctx, `let ${i} = 0`);
      this.emit(ctx, `while ${i} < ${r.range(1, 4)} {`);
      const inner = this.inner(ctx, { loop: true });
      this.emit(inner, `${i} += 1`);
      const k = this.fresh('k');
      this.emit(inner, `let ${k} = ${i}`);
      this.emit(inner, `push(${fs}, fn() => [${i}, ${k}])`);
      this.emit(ctx, '}');
      this.declare(ctx, 'num', false, undefined, i);
    }
    this.emit(ctx, `print(map(${fs}, fn(g) => g()))`);
  }

  private counterMaker(ctx: Ctx): void {
    const r = this.r;
    const mk = this.fresh('mk');
    const c = this.fresh('c');
    const s = this.fresh('s');
    this.emit(ctx, `fn ${mk}(${s}) {`);
    const inner = this.inner(ctx, { fn: true, loop: false });
    this.emit(inner, `let ${c} = ${s}`);
    this.emit(inner, `fn(d) { ${c} += d; ${c} }`);
    this.emit(ctx, '}');
    const a = this.fresh('k');
    const b = this.fresh('k');
    this.emit(ctx, `const ${a} = ${mk}(${r.range(0, 9)})`);
    this.emit(ctx, `const ${b} = ${mk}(${r.range(0, 9)})`);
    this.emit(ctx, `print(${a}(1), ${a}(2), ${b}(10), ${a}(${this.expr(ctx, 'num', 1)}))`);
    this.declare(ctx, 'fn', false, 1, a);
    this.declare(ctx, 'fn', false, 1, b);
  }

  private callStmt(ctx: Ctx): void {
    const fns = this.vars(ctx, 'fn');
    if (!fns.length) return this.printStmt(ctx);
    this.emit(ctx, this.callExpr(ctx, this.r.pick(fns), 2));
  }

  private callExpr(ctx: Ctx, f: Var, d: number): string {
    const args: string[] = [];
    let n = f.arity ?? 1;
    if (this.r.chance(0.005)) n++; // wrong number of arguments: a runtime error
    for (let i = 0; i < n; i++) args.push(this.expr(ctx, 'num', d));
    return `${f.name}(${args.join(', ')})`;
  }

  /**
   * Compound assignment whose right side changes the target first. The old
   * value must be read before the right side runs: x += do { x = 100; 1 }
   * adds 1 to the old x.
   */
  private evaluationOrder(ctx: Ctx): void {
    const r = this.r;
    const k = r.range(0, 9);
    const op = r.pick(['+=', '-=', '*=']);
    const nums = this.vars(ctx, 'num', true);
    const arrs = this.vars(ctx, 'arr');
    const maps = this.vars(ctx, 'map');
    const choice = r.int(3);
    if (choice === 0 && nums.length) {
      const v = r.pick(nums).name;
      this.emit(ctx, `print(${v} ${op} do { ${v} = ${k}; ${this.expr(ctx, 'num', 1)} }, ${v})`);
    } else if (choice === 1 && arrs.length) {
      const a = r.pick(arrs).name;
      this.emit(ctx, `print(${a}[0] ${op} do { ${a}[0] = ${k}; ${this.expr(ctx, 'num', 1)} }, ${a})`);
    } else if (maps.length) {
      const m = r.pick(maps).name;
      this.emit(ctx, `print(${m}.a ${op} do { ${m}.a = ${k}; ${this.expr(ctx, 'num', 1)} }, ${m})`);
    } else {
      this.printStmt(ctx);
    }
  }

  /** A forward reference between functions (or a constant), sometimes used too early (a runtime error). */
  private forwardReference(ctx: Ctx): void {
    const a = this.fresh('fa');
    const b = this.fresh('fb');
    const viaConst = this.r.chance(0.5);
    this.emit(ctx, viaConst ? `fn ${a}() => ${b} + 1` : `fn ${a}() => ${b}() + 1`);
    if (this.r.chance(0.5)) this.emit(ctx, `print(${a}())`);
    this.emit(ctx, viaConst ? `const ${b} = ${this.r.range(0, 9)}` : `fn ${b}() => ${this.r.range(0, 9)}`);
    this.emit(ctx, `print(${a}())`);
    this.declare(ctx, 'fn', false, 0, a);
    if (viaConst) this.declare(ctx, 'num', false, undefined, b);
    else this.declare(ctx, 'fn', false, 0, b);
  }

  // ---- expressions ----------------------------------------------------------

  private leaf(ctx: Ctx, ty: Ty): string {
    const r = this.r;
    const vs = this.vars(ctx, ty);
    if (vs.length && r.chance(0.6)) return r.pick(vs).name;
    switch (ty) {
      case 'num':
        if (r.chance(0.15)) return r.pick(['0.5', '2.5', '0.1', '100', '1e3']);
        return String(r.range(0, 12));
      case 'str':
        return r.pick(STRINGS);
      case 'bool':
        return r.chance(0.5) ? 'true' : 'false';
      case 'arr':
        return `[${r.range(0, 9)}, ${r.range(0, 9)}]`;
      case 'map':
        return `{a: ${r.range(0, 9)}, b: ${r.range(0, 9)}}`;
      case 'fn':
        return `fn(x) => x * ${r.range(1, 4)}`;
    }
  }

  /** A wrong-typed operand now and then, so type errors get compared too. */
  private maybeWrong(ty: Ty): Ty {
    return this.r.chance(0.003) ? this.r.pick<Ty>(['num', 'str', 'bool', 'arr', 'map']) : ty;
  }

  expr(ctx: Ctx, ty: Ty, d: number): string {
    const r = this.r;
    if (d <= 0 || r.chance(0.25)) return this.leaf(ctx, ty);
    const sub = (t: Ty) => this.expr(ctx, this.maybeWrong(t), d - 1);
    switch (ty) {
      case 'num':
        switch (r.int(14)) {
          case 0: case 1: case 2:
          {
            const op = r.pick(['+', '-', '*', '+', '-', '/', '%']);
            // Mostly a non-zero literal divisor, so division by zero stays occasional.
            const right = (op === '/' || op === '%') && r.chance(0.8) ? String(r.range(1, 7)) : sub('num');
            return `(${sub('num')} ${op} ${right})`;
          }
          case 3:
            return `len(${sub(r.pick<Ty>(['str', 'arr', 'map']))})`;
          case 4:
            return `if ${sub('bool')} { ${sub('num')} } else { ${sub('num')} }`;
          case 5: {
            const t = this.fresh('t');
            if (r.chance(0.5)) return `do { let ${t} = ${sub('num')}; ${t} * ${r.range(1, 3)} }`;
            // A closure over a block-local declared in the middle of an expression:
            // its box sits above temporaries on the VM stack.
            const g = this.fresh('g');
            return `do { let ${t} = ${sub('num')}; const ${g} = fn() => ${t} * 2; ${t} += 1; ${g}() + ${t} }`;
          }
          case 6: {
            const fns = this.vars(ctx, 'fn');
            if (!fns.length) return `-${sub('num')}`;
            return this.callExpr(ctx, r.pick(fns), d - 1);
          }
          case 7:
            return `reduce(${sub('arr')}, fn(a, b) => a + b, ${sub('num')})`;
          case 8: {
            const arrs = this.vars(ctx, 'arr');
            const a = arrs.length ? r.pick(arrs).name : sub('arr');
            return `${a}[${this.index(ctx, a)}]`;
          }
          case 9: {
            const maps = this.vars(ctx, 'map');
            const m = maps.length ? r.pick(maps).name : sub('map');
            if (r.chance(0.8)) return `${m}.${r.chance(0.01) ? 'c' : r.pick(['a', 'b'])}`;
            return `${m}["${r.chance(0.1) ? 'z' : r.pick(['a', 'b'])}"]`;
          }
          case 10:
            if (r.chance(0.4)) {
              // A missing key reads as nil; 'or' supplies a default.
              const maps = this.vars(ctx, 'map');
              const m = maps.length ? r.pick(maps).name : sub('map');
              return `(${m}["${r.pick(['a', 'z', 'q'])}"] or ${sub('num')})`;
            }
            return `${r.pick(['floor', 'abs', 'round'])}(${sub('num')})`;
          case 11:
            return `${r.pick(['min', 'max'])}(${sub('num')}, ${sub('num')})`;
          case 12:
            return `(${sub('arr')} |> len)`;
          default:
            return `-${this.leaf(ctx, 'num')}`;
        }
      case 'str':
        switch (r.int(8)) {
          case 0: case 1:
            return `(${sub('str')} ++ ${sub('str')})`;
          case 2:
            return `"<${r.pick(['', 'x', 'n='])}{${sub(this.anyTy())}}|{${sub('num')}}>"`;
          case 3:
            return `str(${sub(this.anyTy())})`;
          case 4:
            return `join(${sub('arr')}, ${r.pick(['","', '"-"', '""'])})`;
          case 5:
            return `type(${sub(this.anyTy())})`;
          case 6:
            return `if ${sub('bool')} { ${sub('str')} } else { ${sub('str')} }`;
          default:
            return `${sub('str')}[0]`;
        }
      case 'bool':
        switch (r.int(7)) {
          case 0: case 1:
            return `(${sub('num')} ${r.pick(['<', '<=', '>', '>=', '==', '!='])} ${sub('num')})`;
          case 2:
            return `(${sub('str')} ${r.pick(['==', '!=', '<'])} ${sub('str')})`;
          case 3:
            return `not ${sub('bool')}`;
          case 4:
            return `(${sub('bool')} ${r.pick(['and', 'or'])} ${sub('bool')})`;
          case 5:
            return `has(${sub('map')}, ${r.pick(['"a"', '"c"', '"z"'])})`;
          default:
            return `(${sub(this.anyTy())} == ${sub(this.anyTy())})`;
        }
      case 'arr':
        switch (r.int(6)) {
          case 0: {
            const n = r.range(0, 4);
            return `[${Array.from({ length: n }, () => sub('num')).join(', ')}]`;
          }
          case 1:
            return `map(${sub('arr')}, fn(x) => ${this.lambdaBody(ctx, d)})`;
          case 2:
            return `filter(${sub('arr')}, fn(x) => x ${r.pick(['>', '<', '!='])} ${sub('num')})`;
          case 3:
            return `(${sub('arr')} ++ ${sub('arr')})`;
          case 4:
            return `map(0..${r.range(0, 4)}, fn(x) => ${this.lambdaBody(ctx, d)})`;
          default:
            return `(${sub('arr')} |> map(fn(x) => x ${r.pick(['+', '*', '-'])} ${r.range(0, 5)}))`;
        }
      case 'map':
        if (r.chance(0.6)) return `{a: ${sub('num')}, b: ${sub('num')}${r.chance(0.3) ? `, c: ${sub('num')}` : ''}}`;
        return `{[${sub('str')}]: ${sub('num')}, a: 1, b: 2}`;
      case 'fn': {
        const p = this.fresh('p');
        const inner = this.inner(ctx, { fn: true, loop: false });
        inner.scopes[inner.scopes.length - 1]!.push({ name: p, ty: 'num', mutable: true });
        const muts = this.vars(ctx, 'num', true).filter((v) => !v.name.startsWith('w'));
        if (muts.length && r.chance(0.4)) {
          // A closure that writes to a captured variable.
          const m = r.pick(muts).name;
          return `fn(${p}) { ${m} += ${p}; ${m} }`;
        }
        return `fn(${p}) => ${this.expr(inner, 'num', d - 1)}`;
      }
    }
  }

  private lambdaBody(ctx: Ctx, d: number): string {
    const inner = this.inner(ctx, { fn: true, loop: false });
    inner.scopes[inner.scopes.length - 1]!.push({ name: 'x', ty: 'num', mutable: true });
    return this.expr(inner, 'num', Math.min(d - 1, 2));
  }
}
