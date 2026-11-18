// Command-line entry point.
//
//   glyph run <file.gly> [--tree] [--no-fold] [--stats]
//   glyph dis <file.gly> [--no-fold]
//   glyph check <file.gly>
//   glyph repl

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { disassemble } from './disasm.js';
import { errorsOf, formatError } from './errors.js';
import { compile, frontEnd, runTree, runVM } from './glyph.js';
import { startRepl } from './repl.js';

const USAGE = `usage:
  glyph run <file.gly> [--tree] [--no-fold] [--stats]   run a program (bytecode VM by default)
  glyph dis <file.gly> [--no-fold]                      print the bytecode
  glyph check <file.gly>                                parse and resolve only
  glyph repl                                            interactive prompt

  --tree      use the tree-walking reference interpreter instead of the VM
  --no-fold   turn off constant folding
  --stats     print instruction count and run time to stderr`;

function readSource(file: string | undefined): string {
  if (!file) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    console.error(`glyph: cannot read ${file}`);
    process.exit(2);
  }
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const file = rest.find((a) => !a.startsWith('--'));
  const fold = !flags.has('--no-fold');

  switch (cmd) {
    case 'run': {
      const source = readSource(file);
      const started = performance.now();
      const opts = { fold, onOutput: (line: string) => process.stdout.write(line + '\n') };
      const r = flags.has('--tree') ? runTree(source, opts) : runVM(source, opts);
      if (flags.has('--stats')) {
        const ms = (performance.now() - started).toFixed(1);
        const engine = flags.has('--tree') ? 'tree-walker' : `vm, ${r.steps.toLocaleString('en-US')} instructions`;
        process.stderr.write(`[${engine}, ${ms} ms]\n`);
      }
      if (r.errors.length) {
        process.stderr.write(r.errors.map((e) => formatError(e, source, file)).join('\n\n') + '\n');
        return 1;
      }
      return 0;
    }
    case 'dis': {
      const source = readSource(file);
      try {
        process.stdout.write(disassemble(compile(source, { fold })));
        return 0;
      } catch (e) {
        const errs = errorsOf(e);
        if (!errs) throw e;
        process.stderr.write(errs.map((x) => formatError(x, source, file)).join('\n\n') + '\n');
        return 1;
      }
    }
    case 'check': {
      const source = readSource(file);
      try {
        frontEnd(source);
        console.log(`${file}: ok`);
        return 0;
      } catch (e) {
        const errs = errorsOf(e);
        if (!errs) throw e;
        process.stderr.write(errs.map((x) => formatError(x, source, file)).join('\n\n') + '\n');
        return 1;
      }
    }
    case 'repl':
      startRepl();
      return 0;
    case '--version':
      console.log('glyph 0.1.0');
      return 0;
    default:
      console.error(USAGE);
      return cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
  }
}

// The tree-walker recurses on the JS stack. Node's default stack is too small
// for it to reach the language's 1000-call limit in deeply nested code, so
// re-run this command with a larger stack (the main thread reserves 8 MB).
const args = process.argv.slice(2);
if (args.includes('--tree') && !process.execArgv.some((a) => a.startsWith('--stack-size'))) {
  const r = spawnSync(process.execPath, ['--stack-size=4000', ...process.execArgv, process.argv[1]!, ...args], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} else {
  const code = main(args);
  if (code !== 0) process.exitCode = code;
}
