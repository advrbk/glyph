// AST node types. The parser builds these; the resolver then fills in the
// optional annotation fields (decl, decls, info, ...) that the compiler needs.
// The tree-walking interpreter ignores the annotations and works by name.

import type { Pos } from './errors.js';
import type { Decl, FnInfo } from './resolver.js';

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '++' | '==' | '!=' | '<' | '<=' | '>' | '>=';
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '++=';

export interface NumLit { kind: 'Num'; value: number; pos: Pos }
export interface StrLit { kind: 'Str'; value: string; pos: Pos }
export interface BoolLit { kind: 'Bool'; value: boolean; pos: Pos }
export interface NilLit { kind: 'Nil'; pos: Pos }

/** "a {x} b": parts alternate between literal text and expressions. */
export interface Interp { kind: 'Interp'; parts: (string | Expr)[]; pos: Pos }

export interface Ident {
  kind: 'Ident';
  name: string;
  pos: Pos;
  /** Set by the resolver: the declaration this name refers to. */
  decl?: Decl;
  /** Set by the resolver when the name is a builtin (index into BUILTINS). */
  builtin?: number;
  /** True when the reference comes textually after the declaration finished. */
  afterDef?: boolean;
}

export interface ArrayLit { kind: 'Array'; items: Expr[]; pos: Pos }
export interface MapEntry { key: string | Expr; value: Expr }
export interface MapLit { kind: 'Map'; entries: MapEntry[]; pos: Pos }
export interface Unary { kind: 'Unary'; op: '-' | 'not'; operand: Expr; pos: Pos }
export interface Binary { kind: 'Binary'; op: BinaryOp; left: Expr; right: Expr; pos: Pos }
export interface Logical { kind: 'Logical'; op: 'and' | 'or'; left: Expr; right: Expr; pos: Pos }
export interface RangeExpr { kind: 'Range'; start: Expr; end: Expr; inclusive: boolean; pos: Pos }
export interface Assign { kind: 'Assign'; op: AssignOp; target: Ident | Index | Field; value: Expr; pos: Pos }
export interface Call { kind: 'Call'; callee: Expr; args: Expr[]; pos: Pos }
export interface Index { kind: 'Index'; object: Expr; index: Expr; pos: Pos }
export interface Field { kind: 'Field'; object: Expr; name: string; pos: Pos }

export interface FnExpr {
  kind: 'Fn';
  name: string | null;
  params: { name: string; pos: Pos }[];
  body: Block;
  pos: Pos;
  /** Set by the resolver. */
  info?: FnInfo;
  paramDecls?: Decl[];
}

export interface IfExpr { kind: 'If'; cond: Expr; then: Block; else: Block | IfExpr | null; pos: Pos }

/** `do { ... }` and every body. Its value is its last expression statement, or nil. */
export interface Block {
  kind: 'Block';
  stmts: Stmt[];
  pos: Pos;
  /** Set by the resolver: names declared directly in this block, in order. */
  decls?: Decl[];
}

export type Expr =
  | NumLit | StrLit | BoolLit | NilLit | Interp | Ident | ArrayLit | MapLit | Unary | Binary
  | Logical | RangeExpr | Assign | Call | Index | Field | FnExpr | IfExpr | Block;

export interface LetStmt { kind: 'Let'; name: string; constant: boolean; init: Expr | null; pos: Pos; decl?: Decl }
export interface FnDecl { kind: 'FnDecl'; name: string; fn: FnExpr; pos: Pos; decl?: Decl }
export interface ReturnStmt { kind: 'Return'; value: Expr | null; pos: Pos }
export interface BreakStmt { kind: 'Break'; pos: Pos }
export interface ContinueStmt { kind: 'Continue'; pos: Pos }
export interface WhileStmt { kind: 'While'; cond: Expr; body: Block; pos: Pos }
export interface ForStmt { kind: 'For'; name: string; namePos: Pos; iterable: Expr; body: Block; pos: Pos; decl?: Decl }
export interface ExprStmt { kind: 'ExprStmt'; expr: Expr; pos: Pos }

export type Stmt = LetStmt | FnDecl | ReturnStmt | BreakStmt | ContinueStmt | WhileStmt | ForStmt | ExprStmt;

export type Literal = NumLit | StrLit | BoolLit | NilLit;

export function isLiteral(e: Expr): e is Literal {
  return e.kind === 'Num' || e.kind === 'Str' || e.kind === 'Bool' || e.kind === 'Nil';
}
