// Runtime values shared by both engines.
//
//   number, string, boolean  -> the JS primitive
//   nil                       -> null
//   array                     -> a plain JS array
//   map                       -> GMap (string keys, insertion order)
//   range                     -> GRange
//   function                  -> a subclass of GFunction (each engine has its own)

export type Value = number | string | boolean | null | Value[] | GMap | GRange | GFunction;

export class GMap {
  readonly entries: Map<string, Value>;

  constructor(entries?: Map<string, Value>) {
    this.entries = entries ?? new Map();
  }
}

export class GRange {
  constructor(
    readonly start: number,
    readonly end: number,
    readonly inclusive: boolean,
  ) {}

  /** One past the last value produced. */
  get stop(): number {
    return this.inclusive ? this.end + 1 : this.end;
  }

  get length(): number {
    return Math.max(0, this.stop - this.start);
  }
}

export abstract class GFunction {
  abstract readonly name: string | null;
}

export type NativeImpl = (args: Value[], ctx: NativeContext) => Value;
/**
 * A native that needs to call back into Glyph code (map, filter, reduce) is a
 * generator: it yields [callee, args] and receives the call's result. This lets
 * the VM run the callback as an ordinary frame, so the VM never re-enters its
 * own dispatch loop and a step-by-step debugger can pause inside callbacks.
 */
export type CallRequest = [callee: Value, args: Value[]];
export type NativeGen = (args: Value[], ctx: NativeContext) => Generator<CallRequest, Value, Value>;

export interface NativeContext {
  out(line: string): void;
}

export class Native extends GFunction {
  constructor(
    readonly name: string,
    readonly minArgs: number,
    readonly maxArgs: number,
    readonly impl: NativeImpl | null,
    readonly gen: NativeGen | null,
  ) {
    super();
  }
}

/** Marks a hoisted variable whose declaration has not run yet. Never visible to programs. */
export const UNINIT: unique symbol = Symbol('uninitialized');

export function typeName(v: Value): string {
  if (v === null) return 'nil';
  switch (typeof v) {
    case 'number': return 'number';
    case 'string': return 'string';
    case 'boolean': return 'bool';
  }
  if (Array.isArray(v)) return 'array';
  if (v instanceof GMap) return 'map';
  if (v instanceof GRange) return 'range';
  return 'function';
}

/** "a number", "an array", "nil". */
export function aType(v: Value): string {
  const t = typeName(v);
  if (t === 'nil') return 'nil';
  return (t === 'array' ? 'an ' : 'a ') + t;
}

export function truthy(v: Value): boolean {
  return v !== false && v !== null;
}

export function equals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a instanceof GRange && b instanceof GRange) {
    return a.start === b.start && a.end === b.end && a.inclusive === b.inclusive;
  }
  return false;
}

export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  return String(n); // String(-0) is "0"
}

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\t': out += '\\t'; break;
      case '\r': out += '\\r'; break;
      case '{': out += '\\{'; break;
      case '}': out += '\\}'; break;
      default: out += ch;
    }
  }
  return out + '"';
}

/** display() for anything that is not an array or a map. */
function displayLeaf(v: Value, nested: boolean): string {
  if (v === null) return 'nil';
  switch (typeof v) {
    case 'number': return formatNumber(v);
    case 'string': return nested ? quote(v) : v;
    case 'boolean': return v ? 'true' : 'false';
  }
  if (v instanceof GRange) return `${v.start}${v.inclusive ? '..=' : '..'}${v.end}`;
  if (v instanceof Native) return `<builtin ${v.name}>`;
  return (v as GFunction).name ? `<fn ${(v as GFunction).name}>` : '<fn>';
}

/** Work items for display(): text to emit, a value to print, or "leaving this container". */
type DisplayWork = string | { value: Value } | { leave: object };

/**
 * The text `print` and `str` produce. Strings print raw at the top level and
 * quoted inside arrays and maps. A container that contains itself prints as
 * [...] or {...} at the point of the cycle.
 *
 * It walks containers with an explicit work stack instead of recursion, so a
 * deeply nested value (say a 100,000-deep linked list) prints instead of
 * overflowing the JS stack.
 */
export function display(v: Value, nested = false): string {
  if (!Array.isArray(v) && !(v instanceof GMap)) return displayLeaf(v, nested);
  const out: string[] = [];
  const onPath = new Set<object>(); // containers currently being printed, for cycles
  const work: DisplayWork[] = [{ value: v }];
  while (work.length > 0) {
    const w = work.pop()!;
    if (typeof w === 'string') {
      out.push(w);
    } else if ('leave' in w) {
      onPath.delete(w.leave);
    } else {
      const x = w.value;
      if (Array.isArray(x)) {
        if (onPath.has(x)) {
          out.push('[...]');
          continue;
        }
        onPath.add(x);
        // Pushed in reverse: '[' comes off first, then the items, then ']'.
        work.push({ leave: x }, ']');
        for (let i = x.length - 1; i >= 0; i--) {
          work.push({ value: x[i]! });
          if (i > 0) work.push(', ');
        }
        work.push('[');
      } else if (x instanceof GMap) {
        if (onPath.has(x)) {
          out.push('{...}');
          continue;
        }
        if (x.entries.size === 0) {
          out.push('{}');
          continue;
        }
        onPath.add(x);
        const entries = [...x.entries];
        work.push({ leave: x }, '}');
        for (let i = entries.length - 1; i >= 0; i--) {
          const [k, item] = entries[i]!;
          work.push({ value: item }, `${BARE_KEY.test(k) ? k : quote(k)}: `);
          if (i > 0) work.push(', ');
        }
        work.push('{');
      } else {
        out.push(displayLeaf(x, true));
      }
    }
  }
  return out.join('');
}
