// The resolver (scope pass). It walks the AST once, before any code runs, and:
//
//  * links every name to its declaration (or to a builtin), reporting
//    undefined names;
//  * reports use before definition in straight-line code, assignment to
//    constants, functions, loop variables and builtins, duplicate declarations,
//    and return/break/continue in the wrong place;
//  * works out which variables are captured by closures, and which captured
//    variables each function has to carry. The compiler stores captured
//    variables in heap boxes and everything else in stack slots.
//
// Declarations are hoisted to the top of their block, so a function can call a
// function declared after it (mutual recursion). Reading a hoisted name in the
// same function before its declaration is a compile error; reading it from a
// nested function is allowed and checked at run time instead, because the call
// may well happen after the declaration has run.

import type { Block, Expr, FnExpr, Ident, Literal, Stmt } from './ast.js';
import { CompileErrors, GlyphError, type Pos } from './errors.js';
import { BUILTIN_INDEX } from './stdlib.js';

export type DeclKind = 'let' | 'const' | 'fn' | 'param' | 'for';

export class FnInfo {
  /** Declarations from enclosing functions that this function reads or writes. */
  readonly captures: Decl[] = [];
  readonly captureIndex = new Map<Decl, number>();

  constructor(
    readonly parent: FnInfo | null,
    readonly name: string,
  ) {}

  capture(d: Decl): number {
    let i = this.captureIndex.get(d);
    if (i === undefined) {
      i = this.captures.length;
      this.captures.push(d);
      this.captureIndex.set(d, i);
    }
    return i;
  }
}

export class Decl {
  /** True once a closure refers to this variable from another function. */
  captured = false;
  /** True once the declaration has been passed during resolution. */
  defined = false;
  /** Global slot number for top-level declarations, -1 otherwise. */
  globalIndex = -1;
  /** Stack slot, assigned by the compiler. */
  slot = -1;
  /** For constants with a literal value; filled in by the constant folder. */
  constValue: Literal | null = null;

  constructor(
    readonly name: string,
    readonly kind: DeclKind,
    readonly pos: Pos,
    readonly fn: FnInfo,
  ) {}

  get global(): boolean {
    return this.globalIndex >= 0;
  }

  get constant(): boolean {
    return this.kind !== 'let' && this.kind !== 'param';
  }
}

/**
 * Top-level names. It outlives one program so the REPL can keep adding lines;
 * redeclaring a global in a later REPL line makes a new global.
 */
export class GlobalScope {
  readonly names: string[] = [];
  readonly decls = new Map<string, Decl>();

  clone(): GlobalScope {
    const g = new GlobalScope();
    g.names.push(...this.names);
    for (const [k, v] of this.decls) g.decls.set(k, v);
    return g;
  }
}

interface Scope {
  decls: Map<string, Decl>;
  fn: FnInfo;
}

export interface ResolveOptions {
  /** REPL mode: a top-level name may be declared again in a later line. */
  allowRedeclare?: boolean;
}

export function resolve(program: Block, globals = new GlobalScope(), opts: ResolveOptions = {}): FnInfo {
  const r = new Resolver(globals, opts);
  const script = r.program(program);
  if (r.errors.length) throw new CompileErrors(r.errors);
  return script;
}

class Resolver {
  readonly errors: GlyphError[] = [];
  private scopes: Scope[] = [];
  private fn!: FnInfo;
  private loopDepth = 0;
  private fnDepth = 0;

  constructor(
    private readonly globals: GlobalScope,
    private readonly opts: ResolveOptions,
  ) {}

  private error(message: string, pos: Pos) {
    this.errors.push(new GlyphError('compile', message, pos));
  }

  program(block: Block): FnInfo {
    this.fn = new FnInfo(null, '<script>');
    // The top-level scope is the global scope.
    const seen = new Set<string>();
    const decls: Decl[] = [];
    for (const s of block.stmts) {
      const d = this.hoisted(s);
      if (!d) continue;
      if (seen.has(d.name)) {
        this.error(`'${d.name}' is already declared in this scope`, d.pos);
        continue;
      }
      seen.add(d.name);
      const old = this.globals.decls.get(d.name);
      if (old && !this.opts.allowRedeclare) {
        this.error(`'${d.name}' is already declared in this scope`, d.pos);
        continue;
      }
      d.globalIndex = this.globals.names.length;
      this.globals.names.push(d.name);
      this.globals.decls.set(d.name, d);
      decls.push(d);
      this.attach(s, d);
    }
    block.decls = decls;
    this.scopes.push({ decls: this.globals.decls, fn: this.fn });
    for (const s of block.stmts) this.stmt(s);
    this.scopes.pop();
    return this.fn;
  }

  /** The declaration a statement introduces into its block, if any. */
  private hoisted(s: Stmt): Decl | null {
    if (s.kind === 'Let') return new Decl(s.name, s.constant ? 'const' : 'let', s.pos, this.fn);
    if (s.kind === 'FnDecl') return new Decl(s.name, 'fn', s.pos, this.fn);
    return null;
  }

  private attach(s: Stmt, d: Decl) {
    if (s.kind === 'Let' || s.kind === 'FnDecl') s.decl = d;
  }

  private block(block: Block) {
    const scope: Scope = { decls: new Map(), fn: this.fn };
    const decls: Decl[] = [];
    for (const s of block.stmts) {
      const d = this.hoisted(s);
      if (!d) continue;
      if (scope.decls.has(d.name)) {
        this.error(`'${d.name}' is already declared in this scope`, d.pos);
        continue;
      }
      scope.decls.set(d.name, d);
      decls.push(d);
      this.attach(s, d);
    }
    block.decls = decls;
    this.scopes.push(scope);
    for (const s of block.stmts) this.stmt(s);
    this.scopes.pop();
  }

  private stmt(s: Stmt) {
    switch (s.kind) {
      case 'Let':
        if (s.init) this.expr(s.init);
        if (s.decl) s.decl.defined = true;
        break;
      case 'FnDecl':
        if (s.decl) s.decl.defined = true;
        this.fnExpr(s.fn);
        break;
      case 'Return':
        if (this.fnDepth === 0) this.error("'return' outside a function", s.pos);
        if (s.value) this.expr(s.value);
        break;
      case 'Break':
      case 'Continue':
        if (this.loopDepth === 0) this.error(`'${s.kind.toLowerCase()}' outside a loop`, s.pos);
        break;
      case 'While':
        this.expr(s.cond);
        this.loopDepth++;
        this.block(s.body);
        this.loopDepth--;
        break;
      case 'For': {
        this.expr(s.iterable);
        const d = new Decl(s.name, 'for', s.namePos, this.fn);
        d.defined = true;
        s.decl = d;
        // The loop variable lives in its own scope around the body, so the
        // body may shadow it. Both scopes are fresh on every iteration.
        this.scopes.push({ decls: new Map([[s.name, d]]), fn: this.fn });
        this.loopDepth++;
        this.block(s.body);
        this.loopDepth--;
        this.scopes.pop();
        break;
      }
      case 'ExprStmt':
        this.expr(s.expr);
        break;
    }
  }

  private expr(e: Expr) {
    switch (e.kind) {
      case 'Num': case 'Str': case 'Bool': case 'Nil':
        return;
      case 'Interp':
        for (const p of e.parts) if (typeof p !== 'string') this.expr(p);
        return;
      case 'Ident':
        this.ident(e, false);
        return;
      case 'Array':
        for (const x of e.items) this.expr(x);
        return;
      case 'Map':
        for (const en of e.entries) {
          if (typeof en.key !== 'string') this.expr(en.key);
          this.expr(en.value);
        }
        return;
      case 'Unary':
        this.expr(e.operand);
        return;
      case 'Binary': case 'Logical':
        this.expr(e.left);
        this.expr(e.right);
        return;
      case 'Range':
        this.expr(e.start);
        this.expr(e.end);
        return;
      case 'Assign':
        if (e.target.kind === 'Ident') {
          this.ident(e.target, true);
        } else if (e.target.kind === 'Index') {
          this.expr(e.target.object);
          this.expr(e.target.index);
        } else {
          this.expr(e.target.object);
        }
        this.expr(e.value);
        return;
      case 'Call':
        this.expr(e.callee);
        for (const a of e.args) this.expr(a);
        return;
      case 'Index':
        this.expr(e.object);
        this.expr(e.index);
        return;
      case 'Field':
        this.expr(e.object);
        return;
      case 'Fn':
        this.fnExpr(e);
        return;
      case 'If':
        this.expr(e.cond);
        this.block(e.then);
        if (e.else) {
          if (e.else.kind === 'If') this.expr(e.else);
          else this.block(e.else);
        }
        return;
      case 'Block':
        this.block(e);
        return;
    }
  }

  private fnExpr(f: FnExpr) {
    const info = new FnInfo(this.fn, f.name ?? '<fn>');
    f.info = info;
    const outerFn = this.fn;
    const outerLoop = this.loopDepth;
    this.fn = info;
    this.loopDepth = 0; // break/continue cannot cross a function boundary
    this.fnDepth++;

    const params = new Map<string, Decl>();
    const paramDecls: Decl[] = [];
    for (const p of f.params) {
      if (params.has(p.name)) this.error(`duplicate parameter '${p.name}'`, p.pos);
      const d = new Decl(p.name, 'param', p.pos, info);
      d.defined = true;
      params.set(p.name, d);
      paramDecls.push(d);
    }
    f.paramDecls = paramDecls;
    this.scopes.push({ decls: params, fn: info });
    this.block(f.body);
    this.scopes.pop();

    this.fnDepth--;
    this.loopDepth = outerLoop;
    this.fn = outerFn;
  }

  private ident(id: Ident, write: boolean) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const d = this.scopes[i]!.decls.get(id.name);
      if (!d) continue;
      id.decl = d;
      id.afterDef = d.defined;
      if (!d.defined && d.fn === this.fn) {
        this.error(`cannot use '${id.name}' before its definition`, id.pos);
      }
      if (write && d.constant) {
        const what = d.kind === 'fn' ? 'function' : d.kind === 'for' ? 'loop variable' : 'constant';
        this.error(`cannot assign to ${what} '${id.name}'`, id.pos);
      }
      if (d.fn !== this.fn && !d.global) {
        // A closure refers to a local of an enclosing function: box it, and
        // make every function in between carry it along.
        d.captured = true;
        for (let f: FnInfo | null = this.fn; f && f !== d.fn; f = f.parent) f.capture(d);
      }
      return;
    }
    const b = BUILTIN_INDEX.get(id.name);
    if (b !== undefined) {
      if (write) this.error(`cannot assign to builtin '${id.name}'`, id.pos);
      id.builtin = b;
      return;
    }
    this.error(`undefined name '${id.name}'`, id.pos);
  }
}
