// The language allows 1000 nested calls. The VM keeps frames on its own stack,
// but the tree-walker recurses on the JS stack, so this checks that it can reach
// the same limit even when every call sits inside deeply nested code.

import { describe, expect, it } from 'vitest';
import { runTree, runVM } from '../src/glyph.js';
import { MAX_CALL_DEPTH } from '../src/ops.js';

const forms: [string, (n: number) => string][] = [
  ['plain recursion', (n) => `fn down(n) => if n == 0 { 0 } else { 1 + down(n - 1) }\nprint(down(${n}))`],
  ['inside blocks and a map callback', (n) => `fn down(n) => if n == 0 { 0 } else { do { let q = [n, {a: n}]; 1 + down(n - 1) + q[0] - n } }\nprint(map([1], fn(x) => down(${n - 2}))[0])`],
  ['inside loops and nested expressions', (n) => `fn down(n) {\n if n == 0 { return 0 }\n let r = 0\n for i in 0..1 { while true { r = 1 + (2 * (0 + do { if true { [down(n - 1)][0] } else { 0 } })) - 2 + 0; break } }\n r\n}\nprint(down(${n}))`],
  ['through reduce callbacks', (n) => `fn down(n) => if n == 0 { 0 } else { reduce([n], fn(a, b) => a + down(n - 1), 1) - 1 }\nprint(down(${Math.floor(n / 3)}))`],
];

describe('call depth limit', () => {
  it(`is ${MAX_CALL_DEPTH} nested calls`, () => {
    expect(MAX_CALL_DEPTH).toBe(1000);
  });

  for (const [name, program] of forms) {
    it(`is reached by both engines: ${name}`, () => {
      // The deepest program that fits runs to the end on both engines.
      const vm = runVM(program(998));
      const tree = runTree(program(998));
      expect(vm.error).toBeNull();
      expect(tree.error).toBeNull();
      expect(tree.output).toEqual(vm.output);
      // Much deeper programs fail on both engines with the same error.
      const deepVm = runVM(program(1500));
      const deepTree = runTree(program(1500));
      expect(deepVm.error?.message).toMatch(/^stack overflow/);
      expect(`${deepTree.error?.message} ${deepTree.error?.pos?.line}:${deepTree.error?.pos?.col}`)
        .toBe(`${deepVm.error?.message} ${deepVm.error?.pos?.line}:${deepVm.error?.pos?.col}`);
    });
  }
});
