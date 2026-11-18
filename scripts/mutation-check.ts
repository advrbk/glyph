// Does the differential fuzzer actually catch bugs? This plants one bug at a
// time in the source (a "mutant"), runs a short fuzz in a fresh process, and
// restores the file. A mutant counts as caught when the engines disagree or
// the run crashes.
//
//   npm run mutation-check            (about a minute)
//
// The mutants in shared code (ops.ts) are expected to survive: both engines
// call the same function, so they agree on the wrong answer. Those bugs are
// what the golden tests are for.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Mutant {
  file: string;
  from: string;
  to: string;
  what: string;
}

const MUTANTS: Mutant[] = [
  {
    file: 'src/compiler.ts',
    what: 'captured loop variable never put in a box',
    from: `        if (d.captured) {
          this.op(Op.BOX_SLOT, s.namePos, 0);`,
    to: `        if (d.captured && f.code.length < 0) {
          this.op(Op.BOX_SLOT, s.namePos, 0);`,
  },
  {
    file: 'src/compiler.ts',
    what: "'break' pops one value too few",
    from: 'this.popN(depth - loop.depth, s.pos);',
    to: 'this.popN(Math.max(0, depth - loop.depth - (s.kind === \'Break\' ? 1 : 0)), s.pos);',
  },
  {
    file: 'src/compiler.ts',
    what: 'block value dropped instead of kept above the locals',
    from: '      this.popUnder(reserved, b.pos);',
    to: '      if (reserved > 1) this.popN(reserved, b.pos), this.op(Op.NIL, b.pos, 1);\n      else this.popUnder(reserved, b.pos);',
  },
  {
    file: 'src/vm.ts',
    what: 'block-local boxes reused across loop iterations (the classic closure-in-a-loop bug)',
    from: '            stack[sp++] = new Box(UN);',
    to: '            stack[sp++] = ((proto as unknown as { shared?: Box }).shared ??= new Box(UN));',
  },
  {
    file: 'src/vm.ts',
    what: "'or' treats nil as truthy",
    from: '            if (v !== false && v !== null) ip += ((code[ip]! << 8) | code[ip + 1]!) + 2;',
    to: '            if (v !== false) ip += ((code[ip]! << 8) | code[ip + 1]!) + 2;',
  },
  {
    file: 'src/vm.ts',
    what: 'forward-reference check removed from captured reads',
    from: '            if (v === UN) fail(ops.uninitMessage(proto.captureNames[i]!));',
    to: '',
  },
  {
    file: 'src/vm.ts',
    what: 'range loop stops one early',
    from: '    if (v >= s.stop) return DONE;',
    to: '    if (v >= s.stop - 1 && s.inclusive) return DONE;\n    if (v >= s.stop) return DONE;',
  },
  {
    file: 'src/fold.ts',
    what: "folder swaps the result of a literal 'or'",
    from: 'return this.hit(e.op === \'and\' ? (t ? right : left) : t ? left : right);',
    to: 'return this.hit(e.op === \'and\' ? (t ? right : left) : t ? right : left);',
  },
  {
    file: 'src/fold.ts',
    what: "folder turns 'if false { a }' (no else) into a instead of nil",
    from: "      if (!e.else) return { kind: 'Nil', pos: e.pos };",
    to: '      if (!e.else) return this.block(e.then);',
  },
  {
    file: 'src/interp.ts',
    what: 'tree-walker: compound assignment to an index reads the old value after the right side',
    from: `      const old = op === null ? null : at(t.pos, () => ops.getIndex(obj, i));
      const v = combine(old, this.eval(e.value, env));`,
    to: `      const rhs = this.eval(e.value, env);
      const old = op === null ? null : at(t.pos, () => ops.getIndex(obj, i));
      const v = combine(old, rhs);`,
  },
  {
    file: 'src/ops.ts',
    what: 'shared code: % uses the sign of the divisor (expected to survive)',
    from: '    return a % b;',
    to: '    return ((a % b) + b) % b;',
  },
];

const seeds = Number(process.env.MUTATION_SEEDS ?? 600);
const results: { what: string; caught: string }[] = [];

for (const m of MUTANTS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) throw new Error(`mutant does not apply: ${m.what}`);
  const out = mkdtempSync(join(tmpdir(), 'glyph-mutant-'));
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    const r = spawnSync(process.execPath, [
      '--stack-size=4000', '--import', 'tsx', 'scripts/fuzz.ts',
      '--seeds', String(seeds), '--from', '5000000', '--save', out,
    ], { encoding: 'utf8' });
    const disagreements = /disagreements:\s+(\d+)/.exec(r.stdout)?.[1];
    let caught: string;
    if (disagreements === undefined) {
      const reason = /(internal compiler error: .*|\w*Error: .*)/.exec(r.stderr)?.[1] ?? 'unknown';
      caught = `yes (crashed: ${reason.slice(0, 70)})`;
    } else if (disagreements === '0') {
      caught = 'no';
    } else {
      caught = `yes (${disagreements} of ${seeds} programs disagree)`;
    }
    results.push({ what: `${m.file}: ${m.what}`, caught });
    console.log(`${m.file}: ${m.what}`);
    console.log(`    caught: ${caught}`);
  } finally {
    writeFileSync(m.file, original);
    rmSync(out, { recursive: true, force: true });
  }
}

const caught = results.filter((r) => r.caught.startsWith('yes')).length;
console.log(`\n${caught} of ${results.length} planted bugs caught with ${seeds} programs each.`);
