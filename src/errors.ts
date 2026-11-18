// Errors shared by every stage. A GlyphError carries a kind (which stage raised
// it), a message, and the source position it points at. Runtime helpers throw
// errors without a position; the engine that called them fills it in, because
// only the engine knows which AST node or instruction was running.

export interface Pos {
  line: number;
  col: number;
}

export type ErrorKind = 'syntax' | 'compile' | 'runtime';

export class GlyphError extends Error {
  readonly kind: ErrorKind;
  pos: Pos | null;

  constructor(kind: ErrorKind, message: string, pos: Pos | null = null) {
    super(message);
    this.name = 'GlyphError';
    this.kind = kind;
    this.pos = pos;
  }
}

/** Thrown by the resolver when it finds one or more compile errors. */
export class CompileErrors extends Error {
  readonly errors: GlyphError[];

  constructor(errors: GlyphError[]) {
    super(errors.map((e) => e.message).join('\n'));
    this.name = 'CompileErrors';
    this.errors = errors;
  }
}

/** Raise a runtime error; the caller's engine attaches the position. */
export function fail(message: string): never {
  throw new GlyphError('runtime', message, null);
}

/** True for the RangeError JavaScript throws when its own call stack runs out. */
export function isJsStackOverflow(e: unknown): boolean {
  return e instanceof RangeError && /call stack/i.test(e.message);
}

/**
 * Turn a JavaScript limit hit by a Glyph operation (a string or array too long
 * for the host) into a runtime error without a position, so both engines report
 * it like any other runtime error. Returns null for anything else.
 */
export function hostLimitError(e: unknown): GlyphError | null {
  if (!(e instanceof RangeError)) return null;
  if (/string length/i.test(e.message)) return new GlyphError('runtime', 'string is too long', null);
  if (/array length/i.test(e.message)) return new GlyphError('runtime', 'array is too long', null);
  return null;
}

/**
 * Run one stage of the front end or the compiler. They recurse over the syntax
 * tree, so absurdly deep nesting (thousands of parentheses, or a 50,000-term
 * sum) can exhaust the JS stack; report that as an error instead of crashing.
 */
export function guardDepth<T>(kind: ErrorKind, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (isJsStackOverflow(e)) throw new GlyphError(kind, 'the program is nested too deeply to compile', null);
    throw e;
  }
}

/** Collect the GlyphErrors carried by anything thrown from the front end. */
export function errorsOf(e: unknown): GlyphError[] | null {
  if (e instanceof GlyphError) return [e];
  if (e instanceof CompileErrors) return e.errors;
  return null;
}

/**
 * Render an error the way the CLI and playground show it:
 *
 *   runtime error: cannot apply '+' to number and string
 *    --> main.gly:3:11
 *     |
 *   3 | let y = x + "a"
 *     |           ^
 */
export function formatError(err: GlyphError, source: string, file = '<input>'): string {
  const title = `${err.kind} error: ${err.message}`;
  if (!err.pos) return title;
  const { line, col } = err.pos;
  const lines = source.split(/\r?\n/);
  const text = lines[line - 1] ?? '';
  const gutter = ' '.repeat(String(line).length);
  // Keep tabs so the caret lines up with the source as the terminal shows it.
  const lead = text.slice(0, Math.max(0, col - 1)).replace(/[^\t]/g, ' ');
  return [
    title,
    `${gutter}--> ${file}:${line}:${col}`,
    `${gutter} |`,
    `${line} | ${text}`,
    `${gutter} | ${lead}^`,
  ].join('\n');
}
