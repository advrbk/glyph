// Golden tests. Each examples/*.gly has an .out file with its exact output, and
// each tests/errors/*.gly has an .err file with the exact error report (message,
// position and caret). Both engines must match the file.
//
// To regenerate after an intended change: UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts
// (then review the diff of the .out/.err files before keeping it).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatError } from '../src/errors.js';
import { runTree, runVM, type RunResult } from '../src/glyph.js';

const update = process.env.UPDATE_GOLDEN === '1';
const root = join(import.meta.dirname, '..');

function render(r: RunResult, source: string, file: string): string {
  const lines = [...r.output];
  for (const e of r.errors) lines.push(formatError(e, source, file));
  return lines.join('\n') + '\n';
}

function golden(dir: string, ext: string) {
  const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.gly')).sort();
  for (const f of files) {
    it(f, () => {
      const path = join(root, dir, f);
      const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      const name = `${dir}/${f}`;
      const vm = render(runVM(source), source, name);
      const vmNoFold = render(runVM(source, { fold: false }), source, name);
      const tree = render(runTree(source), source, name);
      const expectedPath = path.replace(/\.gly$/, ext);
      if (update || !existsSync(expectedPath)) writeFileSync(expectedPath, vm);
      const expected = readFileSync(expectedPath, 'utf8').replace(/\r\n/g, '\n');
      expect(vm).toBe(expected);
      expect(vmNoFold).toBe(expected);
      expect(tree).toBe(expected);
    });
  }
  it(`has a golden file for every program in ${dir}`, () => {
    expect(files.length).toBeGreaterThan(5);
  });
}

describe('example programs', () => golden('examples', '.out'));
describe('error messages', () => golden('tests/errors', '.err'));
