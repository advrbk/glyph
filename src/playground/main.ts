// Browser playground: editor, run on either engine, bytecode listing, and a
// step-by-step view of the VM (current instruction, frames, stack).

import closures from '../../examples/closures.gly';
import collections from '../../examples/collections.gly';
import control from '../../examples/control.gly';
import fib from '../../examples/fib.gly';
import hello from '../../examples/hello.gly';
import life from '../../examples/life.gly';
import mutual from '../../examples/mutual.gly';
import primes from '../../examples/primes.gly';
import sort from '../../examples/sort.gly';
import strings from '../../examples/strings.gly';
import tour from '../../examples/tour.gly';
import type { FnProto, Program } from '../bytecode.js';
import { disassemble, instructions } from '../disasm.js';
import { errorsOf, formatError, type GlyphError, type Pos } from '../errors.js';
import { compile, runTree } from '../glyph.js';
import { display, UNINIT, type Value } from '../values.js';
import { Box, Frame, Iter, NativeFrame, VM } from '../vm.js';

const EXAMPLES: [string, string][] = [
  ['Hello', hello],
  ['Closures', closures],
  ['Fibonacci', fib],
  ['Collections and pipes', collections],
  ['Control flow', control],
  ['Strings', strings],
  ['Sorting', sort],
  ['Primes', primes],
  ['Mutual recursion', mutual],
  ['Game of Life', life],
  ['Language tour', tour],
];

const RUN_SLICE = 200_000; // VM instructions per animation frame while running
const TREE_FUEL = 50_000_000;
const MAX_SHOWN_LINES = 5_000;
const STORAGE_KEY = 'glyph-playground-source';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const code = $<HTMLTextAreaElement>('code');
const gutter = $<HTMLPreElement>('gutter');
const lineMark = $<HTMLDivElement>('lineMark');
const output = $<HTMLPreElement>('output');
const bytecode = $<HTMLPreElement>('bytecode');
const status = $<HTMLSpanElement>('status');
const examples = $<HTMLSelectElement>('examples');
const engine = $<HTMLSelectElement>('engine');
const fold = $<HTMLInputElement>('fold');
const buttons = {
  run: $<HTMLButtonElement>('run'),
  debug: $<HTMLButtonElement>('debug'),
  step: $<HTMLButtonElement>('step'),
  step10: $<HTMLButtonElement>('step10'),
  line: $<HTMLButtonElement>('line'),
  cont: $<HTMLButtonElement>('continue'),
  stop: $<HTMLButtonElement>('stop'),
};

type Mode = 'idle' | 'running' | 'debugging';
let mode: Mode = 'idle';
let vm: VM | null = null;
let program: Program | null = null;
let lines: string[] = [];
let stopRequested = false;
let startedAt = 0;

// ---- small helpers ----------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatus(text: string, kind: '' | 'ok' | 'err' | 'busy' = ''): void {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function setMode(m: Mode): void {
  mode = m;
  const debugging = m === 'debugging';
  buttons.run.disabled = m === 'running';
  buttons.debug.disabled = m === 'running';
  buttons.step.disabled = !debugging;
  buttons.step10.disabled = !debugging;
  buttons.line.disabled = !debugging;
  buttons.cont.disabled = !debugging;
  buttons.stop.disabled = m === 'idle';
  code.readOnly = m !== 'idle';
}

function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll<HTMLElement>('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  if (name === 'bytecode') renderBytecode();
}

function activeTab(): string {
  return document.querySelector<HTMLButtonElement>('.tab.active')?.dataset.tab ?? 'output';
}

// ---- editor -----------------------------------------------------------------

function lineHeight(): number {
  return parseFloat(getComputedStyle(code).lineHeight) || 21;
}

function updateGutter(): void {
  const n = code.value.split('\n').length;
  let s = '';
  for (let i = 1; i <= n; i++) s += i + '\n';
  gutter.textContent = s;
  gutter.scrollTop = code.scrollTop;
  placeLineMark();
}

let markedLine: number | null = null;
let markIsError = false;

function markLine(line: number | null, isError = false, scroll = true): void {
  markedLine = line;
  markIsError = isError;
  if (line !== null && scroll) {
    const lh = lineHeight();
    const top = (line - 1) * lh;
    if (top < code.scrollTop || top > code.scrollTop + code.clientHeight - lh * 2) {
      code.scrollTop = Math.max(0, top - code.clientHeight / 3);
    }
  }
  placeLineMark();
}

function placeLineMark(): void {
  if (markedLine === null) {
    lineMark.hidden = true;
    return;
  }
  lineMark.hidden = false;
  lineMark.classList.toggle('error', markIsError);
  lineMark.style.top = `${12 + (markedLine - 1) * lineHeight() - code.scrollTop}px`;
}

code.addEventListener('scroll', () => {
  gutter.scrollTop = code.scrollTop;
  placeLineMark();
});

let bytecodeTimer: number | undefined;
code.addEventListener('input', () => {
  updateGutter();
  markLine(null);
  try {
    localStorage.setItem(STORAGE_KEY, code.value);
  } catch {
    // storage may be unavailable (private mode, file://); the playground works without it
  }
  if (activeTab() === 'bytecode') {
    clearTimeout(bytecodeTimer);
    bytecodeTimer = window.setTimeout(renderBytecode, 300);
  }
});

code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (mode === 'idle') run();
    return;
  }
  if (e.key === 'Tab' && !e.shiftKey && !code.readOnly) {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = code;
    code.value = value.slice(0, a) + '  ' + value.slice(b);
    code.selectionStart = code.selectionEnd = a + 2;
    code.dispatchEvent(new Event('input'));
  }
});

// ---- output -----------------------------------------------------------------

function renderOutput(extra = ''): void {
  const shown = lines.length > MAX_SHOWN_LINES
    ? [...lines.slice(0, MAX_SHOWN_LINES), `... ${lines.length - MAX_SHOWN_LINES} more lines`]
    : lines;
  output.innerHTML = esc(shown.join('\n')) + (shown.length && extra ? '\n' : '') + extra;
  output.scrollTop = output.scrollHeight;
}

function errorHtml(errs: GlyphError[], source: string): string {
  return errs.map((e) => `<span class="err">${esc(formatError(e, source, 'main.gly'))}</span>`).join('\n\n');
}

function showErrors(errs: GlyphError[], source: string): void {
  renderOutput(errorHtml(errs, source));
  const p = errs[0]?.pos;
  markLine(p ? p.line : null, true);
}

function tryCompile(source: string): Program | null {
  try {
    return compile(source, { fold: fold.checked });
  } catch (e) {
    const errs = errorsOf(e);
    if (!errs) throw e;
    lines = [];
    showErrors(errs, source);
    setStatus(`${errs[0]!.kind} error`, 'err');
    showTab('output');
    return null;
  }
}

// ---- bytecode tab -------------------------------------------------------------

function highlightListing(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      if (l.startsWith('==')) return `<span class="fn">${esc(l)}</span>`;
      const m = /^(\d{4})(\s+\S+)(\s+.*)$/.exec(l);
      if (!m) return esc(l);
      return `<span class="off">${m[1]}</span><span class="pos">${esc(m[2]!)}</span>${esc(m[3]!)}`;
    })
    .join('\n');
}

function renderBytecode(): void {
  const source = code.value;
  try {
    bytecode.innerHTML = highlightListing(disassemble(compile(source, { fold: fold.checked })));
  } catch (e) {
    const errs = errorsOf(e);
    if (!errs) throw e;
    bytecode.innerHTML = errorHtml(errs, source);
  }
}

// ---- running ------------------------------------------------------------------

function newVM(): VM {
  return new VM({ out: (line) => lines.push(line) });
}

function finish(): void {
  const ms = (performance.now() - startedAt).toFixed(1);
  if (!vm) return;
  if (vm.status === 'error' && vm.error) {
    showErrors([vm.error], code.value);
    setStatus(`runtime error after ${vm.steps.toLocaleString()} instructions`, 'err');
  } else if (vm.status === 'done') {
    renderOutput(lines.length ? '' : '<span class="note">(no output)</span>');
    markLine(null);
    setStatus(`done: ${vm.steps.toLocaleString()} instructions in ${ms} ms`, 'ok');
  } else {
    renderOutput('<span class="note">stopped</span>');
    setStatus(`stopped after ${vm.steps.toLocaleString()} instructions`);
  }
  setMode('idle');
  if (activeTab() === 'debugger') renderDebugger();
}

/** An exception that is not a Glyph error is a bug in Glyph; show it and unlock the page. */
function internalError(e: unknown): void {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  renderOutput(`<span class="err">internal error: ${esc(msg)}</span>`);
  setStatus('internal error', 'err');
  setMode('idle');
}

function pump(): void {
  if (!vm) return;
  if (stopRequested) {
    finish();
    return;
  }
  let st;
  try {
    st = vm.run(RUN_SLICE);
  } catch (e) {
    internalError(e);
    return;
  }
  if (st === 'paused') {
    renderOutput();
    setStatus(`running: ${vm.steps.toLocaleString()} instructions`, 'busy');
    requestAnimationFrame(pump);
  } else {
    finish();
  }
}

function run(): void {
  const source = code.value;
  lines = [];
  markLine(null);
  stopRequested = false;
  if (activeTab() === 'debugger') showTab('output');
  if (engine.value === 'tree') {
    startedAt = performance.now();
    let r;
    try {
      r = runTree(source, { fold: fold.checked, fuel: TREE_FUEL, onOutput: (l) => lines.push(l) });
    } catch (e) {
      internalError(e);
      return;
    }
    const ms = (performance.now() - startedAt).toFixed(1);
    lines = r.output;
    if (r.errors.length) {
      showErrors(r.errors, source);
      setStatus(`${r.errors[0]!.kind} error (tree-walker)`, 'err');
    } else if (r.outOfFuel) {
      renderOutput(`<span class="note">stopped after ${TREE_FUEL.toLocaleString()} evaluation steps</span>`);
      setStatus('stopped (step limit)');
    } else {
      renderOutput(lines.length ? '' : '<span class="note">(no output)</span>');
      setStatus(`done on the tree-walker in ${ms} ms`, 'ok');
    }
    return;
  }
  program = tryCompile(source);
  if (!program) return;
  vm = newVM();
  vm.load(program);
  startedAt = performance.now();
  setMode('running');
  setStatus('running', 'busy');
  pump();
}

// ---- debugger -----------------------------------------------------------------

function debugStart(): void {
  lines = [];
  stopRequested = false;
  program = tryCompile(code.value);
  if (!program) return;
  vm = newVM();
  vm.load(program);
  startedAt = performance.now();
  setMode('debugging');
  showTab('debugger');
  setStatus('paused at the first instruction', 'busy');
  renderDebugger();
}

function afterStep(): void {
  if (!vm) return;
  if (vm.status === 'paused') {
    setStatus(`paused: ${vm.steps.toLocaleString()} instructions run`, 'busy');
    renderDebugger();
  } else {
    finish();
    renderDebugger();
  }
}

function step(n: number): void {
  if (!vm || mode !== 'debugging') return;
  try {
    vm.run(n);
  } catch (e) {
    internalError(e);
    return;
  }
  afterStep();
}

function nextLine(): void {
  if (!vm || mode !== 'debugging') return;
  const start = vm.currentPos()?.line;
  const depth = vm.frames.length;
  for (let i = 0; i < 100_000 && vm.status === 'paused'; i++) {
    vm.run(1);
    const p = vm.currentPos();
    if (vm.frames.length !== depth || (p && p.line !== start)) break;
  }
  afterStep();
}

function shortValue(v: unknown): string {
  let s: string;
  if (v === UNINIT) s = '<uninitialized>';
  else if (v instanceof Box) s = `box -> ${v.v === UNINIT ? '<uninitialized>' : display(v.v as Value, true)}`;
  else if (v instanceof Iter) s = `<iterator at ${v.i}>`;
  else s = display(v as Value, true);
  return s.length > 70 ? s.slice(0, 67) + '...' : s;
}

function frameName(f: Frame | NativeFrame): string {
  if (f instanceof NativeFrame) return `${f.native.name} (builtin)`;
  const n = f.closure.proto.name;
  return n === '<script>' ? '<script>' : n ? `fn ${n}` : 'fn (anonymous)';
}

function posText(p: Pos | null | undefined): string {
  return p ? `${p.line}:${p.col}` : '';
}

function renderDebugger(): void {
  const empty = $<HTMLDivElement>('debugEmpty');
  const view = $<HTMLDivElement>('debugView');
  if (!vm || (mode !== 'debugging' && vm.status !== 'done' && vm.status !== 'error')) {
    empty.hidden = false;
    view.hidden = true;
    return;
  }
  empty.hidden = true;
  view.hidden = false;

  // Current function listing with the next instruction highlighted.
  let top: Frame | null = null;
  for (let i = vm.frames.length - 1; i >= 0; i--) {
    const f = vm.frames[i];
    if (f instanceof Frame) {
      top = f;
      break;
    }
  }
  const fnListing = $<HTMLPreElement>('fnListing');
  const fnName = $<HTMLSpanElement>('fnName');
  if (top && vm.status !== 'done') {
    const proto: FnProto = top.closure.proto;
    fnName.textContent = frameName(top);
    const names = program?.globalNames ?? [];
    fnListing.innerHTML = instructions(proto, names)
      .map((ins) => {
        const pos = proto.positions[ins.offset];
        const row = `<span class="off">${String(ins.offset).padStart(4, '0')}</span> <span class="pos">${posText(pos).padStart(6)}</span>  ${esc(ins.text)}`;
        return ins.offset === top!.ip ? `<span class="cur" id="curIns">${row}</span>` : row;
      })
      .join('\n');
    document.getElementById('curIns')?.scrollIntoView({ block: 'nearest' });
  } else {
    fnName.textContent = vm.status === 'done' ? 'finished' : '';
    fnListing.textContent = vm.status === 'done' ? 'The program has finished.' : '';
  }

  // Frames, innermost first.
  $<HTMLOListElement>('frames').innerHTML = [...vm.frames]
    .reverse()
    .map((f) => {
      const where = f instanceof Frame ? posText(f.closure.proto.positions[f.ip]) : 'waiting for a callback';
      return `<li><span>${esc(frameName(f))}</span><span class="muted">${esc(where)}</span></li>`;
    })
    .join('') || '<li class="muted">(none)</li>';

  // Stack, top first, with slot names where the compiler recorded them.
  const owner = (i: number): Frame | null => {
    let best: Frame | null = null;
    for (const f of vm!.frames) if (f instanceof Frame && f.base - 1 <= i) best = f;
    return best;
  };
  const rows: string[] = [];
  for (let i = vm.sp - 1; i >= 0 && rows.length < 200; i--) {
    const f = owner(i);
    let name = 'temp';
    let isBase = false;
    if (f) {
      const slot = i - f.base;
      if (slot === -1) {
        name = 'callee';
        isBase = true;
      } else {
        name = f.closure.proto.slotNames[slot] ?? 'temp';
      }
    }
    const cls = [isBase ? 'base' : '', i === vm.sp - 1 ? 'top' : ''].join(' ').trim();
    rows.push(`<li class="${cls}"><span class="idx">${i}</span><span class="name">${esc(name)}</span><span class="val">${esc(shortValue(vm.stack[i]))}</span></li>`);
  }
  $<HTMLOListElement>('stack').innerHTML = rows.join('') || '<li class="muted">(empty)</li>';

  $<HTMLPreElement>('debugOutput').textContent = lines.slice(-200).join('\n');
  if (vm.status === 'paused') markLine(vm.currentPos()?.line ?? null);
}

// ---- wiring -------------------------------------------------------------------

for (const [name] of EXAMPLES) {
  const o = document.createElement('option');
  o.value = name;
  o.textContent = name;
  examples.appendChild(o);
}

examples.addEventListener('change', () => {
  const found = EXAMPLES.find(([n]) => n === examples.value);
  if (!found || mode !== 'idle') return;
  code.value = found[1];
  code.scrollTop = 0;
  code.dispatchEvent(new Event('input'));
  lines = [];
  renderOutput();
  setStatus('Ready');
});

fold.addEventListener('change', () => {
  if (activeTab() === 'bytecode') renderBytecode();
});

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    showTab(t.dataset.tab!);
    if (t.dataset.tab === 'debugger') renderDebugger();
  });
});

buttons.run.addEventListener('click', run);
buttons.debug.addEventListener('click', debugStart);
buttons.step.addEventListener('click', () => step(1));
buttons.step10.addEventListener('click', () => step(10));
buttons.line.addEventListener('click', nextLine);
buttons.cont.addEventListener('click', () => {
  if (!vm) return;
  setMode('running');
  showTab('output');
  startedAt = performance.now();
  pump();
});
buttons.stop.addEventListener('click', () => {
  if (mode === 'running') {
    stopRequested = true;
  } else if (mode === 'debugging') {
    stopRequested = true;
    finish();
    markLine(null);
  }
});

let saved: string | null = null;
try {
  saved = localStorage.getItem(STORAGE_KEY);
} catch {
  saved = null;
}
code.value = saved ?? EXAMPLES[1]![1];
if (!saved) examples.value = EXAMPLES[1]![0];
updateGutter();
setMode('idle');
window.addEventListener('resize', placeLineMark);
