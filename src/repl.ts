// Interactive prompt. Every line is compiled and run on one long-lived VM, so
// globals declared on earlier lines stay available. Input that ends in the
// middle of an expression or block continues on the next line.

import { createInterface } from 'node:readline';
import { compileProgram } from './compiler.js';
import { errorsOf, formatError } from './errors.js';
import { frontEnd } from './glyph.js';
import { GlobalScope } from './resolver.js';
import { display } from './values.js';
import { VM } from './vm.js';

export interface ReplSession {
  /** Feed one chunk of input; returns the text to show, or null if more input is needed. */
  feed(chunk: string): string | null;
}

export function createSession(write: (line: string) => void): ReplSession {
  let globals = new GlobalScope();
  const vm = new VM({ out: write });
  return {
    feed(source: string): string | null {
      const scope = globals.clone();
      let program;
      try {
        const fe = frontEnd(source, { globals: scope, repl: true });
        // Compiling can fail too (a limit such as 255 arguments), so it is inside the try.
        program = compileProgram(fe.ast, fe.script, fe.globals);
      } catch (e) {
        const errs = errorsOf(e);
        if (!errs) throw e;
        // Unfinished input such as "fn f() {" or "1 +": wait for more lines.
        if (errs[0]!.kind === 'syntax' && /end of input/.test(errs[0]!.message)) {
          return null;
        }
        return errs.map((x) => formatError(x, source, '<repl>')).join('\n\n');
      }
      globals = scope;
      vm.load(program);
      vm.run();
      if (vm.error) return formatError(vm.error, source, '<repl>');
      return vm.result === null ? '' : `=> ${display(vm.result, true)}`;
    },
  };
}

export function startRepl(): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'glyph> ' });
  const session = createSession((line) => console.log(line));
  let buffer = '';
  console.log('Glyph REPL. Type an expression or statement; :quit or Ctrl+D to leave.');
  rl.prompt();
  rl.on('line', (line) => {
    if (buffer === '' && line.trim() === ':quit') {
      rl.close();
      return;
    }
    buffer += (buffer ? '\n' : '') + line;
    const shown = session.feed(buffer);
    if (shown === null) {
      rl.setPrompt('  ...> ');
    } else {
      if (shown) console.log(shown);
      buffer = '';
      rl.setPrompt('glyph> ');
    }
    rl.prompt();
  });
  rl.on('close', () => process.stdout.write('\n'));
}
