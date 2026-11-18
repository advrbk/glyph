// The standard library. Both engines share these natives. Natives that call
// back into Glyph code (map, filter, reduce) are generators; see values.ts.

import { fail } from './errors.js';
import {
  aType, display, GMap, GRange, Native, truthy, typeName,
  type CallRequest, type NativeContext, type NativeGen, type NativeImpl, type Value,
} from './values.js';

const start = typeof performance !== 'undefined' ? performance.now() : Date.now();

function plain(name: string, min: number, max: number, impl: NativeImpl): Native {
  return new Native(name, min, max, impl, null);
}

function gen(name: string, min: number, max: number, g: NativeGen): Native {
  return new Native(name, min, max, null, g);
}

function wrongType(fn: string, expected: string, v: Value, argNo?: number): never {
  const which = argNo === undefined ? '' : ` as argument ${argNo}`;
  fail(`${fn} expects ${expected}${which}, got ${aType(v)}`);
}

function num(fn: string, v: Value, argNo?: number): number {
  if (typeof v !== 'number') wrongType(fn, 'a number', v, argNo);
  return v;
}

function str(fn: string, v: Value, argNo?: number): string {
  if (typeof v !== 'string') wrongType(fn, 'a string', v, argNo);
  return v;
}

function arr(fn: string, v: Value, argNo?: number): Value[] {
  if (!Array.isArray(v)) wrongType(fn, 'an array', v, argNo);
  return v;
}

function map(fn: string, v: Value, argNo?: number): GMap {
  if (!(v instanceof GMap)) wrongType(fn, 'a map', v, argNo);
  return v;
}

function int(fn: string, v: Value, argNo: number): number {
  const n = num(fn, v, argNo);
  if (!Number.isInteger(n)) fail(`${fn} expects an integer as argument ${argNo}, got ${n}`);
  return n;
}

/**
 * Walk an array (by index, re-reading its length each step, like a for loop)
 * or a range. Used by the callback natives.
 */
function* items(fn: string, v: Value): Generator<Value, void, unknown> {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield v[i]!;
  } else if (v instanceof GRange) {
    for (let i = v.start; i < v.stop; i++) yield i;
  } else {
    wrongType(fn, 'an array or range', v, 1);
  }
}

const NUMBER_SYNTAX = /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/;

export const BUILTINS: Native[] = [
  plain('print', 0, Infinity, (args, ctx) => {
    ctx.out(args.map((a) => display(a)).join(' '));
    return null;
  }),
  plain('len', 1, 1, ([v]) => {
    if (typeof v === 'string' || Array.isArray(v)) return v.length;
    if (v instanceof GMap) return v.entries.size;
    if (v instanceof GRange) return v.length;
    wrongType('len', 'a string, array, map or range', v!);
  }),
  plain('push', 2, 2, ([a, v]) => {
    arr('push', a!, 1).push(v!);
    return a!;
  }),
  plain('pop', 1, 1, ([a]) => {
    const xs = arr('pop', a!);
    if (xs.length === 0) fail('pop from an empty array');
    return xs.pop() as Value;
  }),
  plain('keys', 1, 1, ([m]) => [...map('keys', m!).entries.keys()]),
  plain('has', 2, 2, ([m, k]) => map('has', m!, 1).entries.has(str('has', k!, 2))),
  gen('map', 2, 2, function* ([xs, f]) {
    const out: Value[] = [];
    for (const x of items('map', xs!)) out.push(yield [f!, [x]] as CallRequest);
    return out;
  }),
  gen('filter', 2, 2, function* ([xs, f]) {
    const out: Value[] = [];
    for (const x of items('filter', xs!)) {
      if (truthy(yield [f!, [x]] as CallRequest)) out.push(x);
    }
    return out;
  }),
  gen('reduce', 3, 3, function* ([xs, f, init]) {
    let acc: Value = init!;
    for (const x of items('reduce', xs!)) acc = yield [f!, [acc, x]] as CallRequest;
    return acc;
  }),
  plain('str', 1, 1, ([v]) => display(v!)),
  plain('num', 1, 1, ([v]) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return NUMBER_SYNTAX.test(v) ? Number(v) : null;
    wrongType('num', 'a string or number', v!);
  }),
  plain('type', 1, 1, ([v]) => typeName(v!)),
  plain('floor', 1, 1, ([v]) => Math.floor(num('floor', v!))),
  plain('round', 1, 1, ([v]) => Math.round(num('round', v!))),
  plain('abs', 1, 1, ([v]) => Math.abs(num('abs', v!))),
  plain('sqrt', 1, 1, ([v]) => Math.sqrt(num('sqrt', v!))),
  plain('min', 2, 2, ([a, b]) => Math.min(num('min', a!, 1), num('min', b!, 2))),
  plain('max', 2, 2, ([a, b]) => Math.max(num('max', a!, 1), num('max', b!, 2))),
  plain('join', 2, 2, ([xs, sep]) => {
    const parts = arr('join', xs!, 1).map((x) => display(x));
    return parts.join(str('join', sep!, 2));
  }),
  plain('split', 2, 2, ([s, sep]) => str('split', s!, 1).split(str('split', sep!, 2))),
  plain('slice', 3, 3, ([v, a, b]) => {
    if (typeof v !== 'string' && !Array.isArray(v)) wrongType('slice', 'a string or array', v!, 1);
    const from = int('slice', a!, 2);
    const to = int('slice', b!, 3);
    if (from < 0 || to < from || to > v.length) {
      fail(`slice ${from}..${to} is out of bounds (length ${v.length})`);
    }
    return v.slice(from, to);
  }),
  plain('clock', 0, 0, () => ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start) / 1000),
  plain('assert', 1, 2, ([cond, msg]) => {
    if (!truthy(cond!)) fail(msg === undefined ? 'assertion failed' : `assertion failed: ${display(msg)}`);
    return null;
  }),
  plain('error', 1, 1, ([msg]) => fail(display(msg!))),
];

export const BUILTIN_INDEX = new Map(BUILTINS.map((b, i) => [b.name, i]));

/** Check a native's argument count (raises the same message in both engines). */
export function checkNativeArity(n: Native, argc: number): void {
  if (argc < n.minArgs || argc > n.maxArgs) {
    const expected = n.minArgs === n.maxArgs
      ? `${n.minArgs} argument${n.minArgs === 1 ? '' : 's'}`
      : n.maxArgs === Infinity
        ? `at least ${n.minArgs} arguments`
        : `${n.minArgs} to ${n.maxArgs} arguments`;
    fail(`${n.name} expects ${expected}, got ${argc}`);
  }
}

export function callPlain(n: Native, args: Value[], ctx: NativeContext): Value {
  checkNativeArity(n, args.length);
  return n.impl!(args, ctx);
}
