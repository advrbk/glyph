// Operator semantics, shared by the VM, the tree-walker and the constant
// folder. Every function either returns a value or throws a runtime error
// with no position (the caller attaches it).

import { fail } from './errors.js';
import { aType, equals, GMap, GRange, typeName, type Value } from './values.js';

function arith(op: string, a: Value, b: Value): never {
  const hint = op === '+' && (typeof a === 'string' || typeof b === 'string') ? ' (use ++ to join strings)' : '';
  fail(`cannot apply '${op}' to ${typeName(a)} and ${typeName(b)}${hint}`);
}

export function add(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  arith('+', a, b);
}

export function sub(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  arith('-', a, b);
}

export function mul(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a * b;
  arith('*', a, b);
}

export function div(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') {
    if (b === 0) fail('division by zero');
    return a / b;
  }
  arith('/', a, b);
}

export function mod(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') {
    if (b === 0) fail('modulo by zero');
    return a % b;
  }
  arith('%', a, b);
}

export function concat(a: Value, b: Value): Value {
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  fail(`cannot apply '++' to ${typeName(a)} and ${typeName(b)} (both sides must be strings, or both arrays)`);
}

export function compare(op: '<' | '<=' | '>' | '>=', a: Value, b: Value): boolean {
  if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) {
    switch (op) {
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
    }
  }
  fail(`cannot compare ${typeName(a)} with ${typeName(b)} using '${op}'`);
}

export function negate(a: Value): Value {
  if (typeof a === 'number') return -a;
  fail(`cannot apply unary '-' to ${aType(a)}`);
}

export function binary(op: string, a: Value, b: Value): Value {
  switch (op) {
    case '+': return add(a, b);
    case '-': return sub(a, b);
    case '*': return mul(a, b);
    case '/': return div(a, b);
    case '%': return mod(a, b);
    case '++': return concat(a, b);
    case '==': return equals(a, b);
    case '!=': return !equals(a, b);
    case '<': case '<=': case '>': case '>=': return compare(op, a, b);
  }
  throw new Error(`unknown operator ${op}`);
}

export function makeRange(start: Value, end: Value, inclusive: boolean): GRange {
  checkRangeBound('start', start);
  checkRangeBound('end', end);
  return new GRange(start as number, end as number, inclusive);
}

// Past 2^53 a double cannot count by one (2^53 + 1 === 2^53), so a range there
// would repeat or skip items. Ranges are limited to the exactly countable integers.
function checkRangeBound(which: string, v: Value): void {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    fail(`range ${which} must be an integer, got ${describeValue(v)}`);
  }
  if (!Number.isSafeInteger(v)) {
    fail(`range ${which} ${describeValue(v)} is too large (ranges must stay within +/-9007199254740991)`);
  }
}

function describeValue(v: Value): string {
  return typeof v === 'number' ? String(v) : typeName(v);
}

function checkPosition(i: Value, length: number, what: string): number {
  if (typeof i !== 'number') fail(`${what} index must be a number, got ${typeName(i)}`);
  if (!Number.isInteger(i)) fail(`${what} index must be an integer, got ${i}`);
  if (i < 0 || i >= length) fail(`index ${i} is out of bounds (length ${length})`);
  return i;
}

function mapKey(k: Value): string {
  if (typeof k !== 'string') fail(`map keys must be strings, got ${typeName(k)}`);
  return k;
}

export function getIndex(obj: Value, i: Value): Value {
  if (Array.isArray(obj)) return obj[checkPosition(i, obj.length, 'array')]!;
  if (typeof obj === 'string') return obj[checkPosition(i, obj.length, 'string')]!;
  if (obj instanceof GMap) {
    const v = obj.entries.get(mapKey(i));
    return v === undefined ? null : v;
  }
  fail(`cannot index ${aType(obj)}`);
}

export function setIndex(obj: Value, i: Value, v: Value): Value {
  if (Array.isArray(obj)) {
    obj[checkPosition(i, obj.length, 'array')] = v;
    return v;
  }
  if (obj instanceof GMap) {
    obj.entries.set(mapKey(i), v);
    return v;
  }
  if (typeof obj === 'string') fail('strings cannot be changed; build a new one with ++');
  fail(`cannot assign into ${aType(obj)}`);
}

export function getField(obj: Value, name: string): Value {
  if (obj instanceof GMap) {
    const v = obj.entries.get(name);
    if (v === undefined) fail(`map has no key '${name}'`);
    return v;
  }
  fail(`cannot read field '${name}' of ${aType(obj)}`);
}

export function setField(obj: Value, name: string, v: Value): Value {
  if (obj instanceof GMap) {
    obj.entries.set(name, v);
    return v;
  }
  fail(`cannot set field '${name}' on ${aType(obj)}`);
}

/** Build a map literal from evaluated [key, value] pairs. */
export function buildMap(pairs: Value[]): GMap {
  const m = new GMap();
  for (let i = 0; i < pairs.length; i += 2) {
    const k = pairs[i]!;
    if (typeof k !== 'string') fail(`map keys must be strings, got ${typeName(k)}`);
    m.entries.set(k, pairs[i + 1]!);
  }
  return m;
}

export function arityMessage(name: string | null, expected: number, got: number): string {
  const who = name ? `function '${name}'` : 'function';
  return `${who} expects ${expected} argument${expected === 1 ? '' : 's'}, got ${got}`;
}

export function notCallable(v: Value): string {
  return `cannot call ${aType(v)}`;
}

export const MAX_CALL_DEPTH = 1000;
export const STACK_OVERFLOW = `stack overflow (more than ${MAX_CALL_DEPTH} nested calls)`;

export function uninitMessage(name: string): string {
  return `'${name}' was used before its definition ran`;
}
