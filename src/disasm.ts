// Disassembler: prints bytecode as a readable listing.
//
//   == fn fib (arity 1, 4 constants, 32 bytes) ==
//   0000   2:6  GET_LOCAL       0 n
//   0002    |   CONST           0 2
//   0005    |   LT
//   0006    |   JUMP_IF_FALSE   6 -> 15

import { FnProto, OPERANDS, Op, isProto } from './bytecode.js';
import { display, quote } from './values.js';
import type { Program } from './bytecode.js';
import { BUILTINS } from './stdlib.js';

export interface Instruction {
  offset: number;
  size: number;
  op: Op;
  text: string;
}

function hex(n: number): string {
  return String(n).padStart(4, '0');
}

function constText(p: FnProto, i: number): string {
  const v = p.constants[i];
  if (isProto(v)) return `<fn ${v.name ?? 'anonymous'}>`;
  if (typeof v === 'string') return quote(v);
  return display(v ?? null);
}

/** Decode one instruction at `offset`. */
export function decode(p: FnProto, offset: number, globalNames: string[] = []): Instruction {
  const code = p.code;
  const op = code[offset] as Op;
  const name = Op[op] ?? `?${op}`;
  const u8 = () => code[offset + 1]!;
  const u16 = () => (code[offset + 1]! << 8) | code[offset + 2]!;
  const pad = name.padEnd(16);
  switch (OPERANDS[op]) {
    case 'none':
      return { offset, size: 1, op, text: name };
    case 'u8': {
      const n = u8();
      let note = '';
      if (op === Op.GET_LOCAL || op === Op.SET_LOCAL || op === Op.INIT_LOCAL || op === Op.GET_BOX
        || op === Op.SET_BOX || op === Op.INIT_BOX || op === Op.BOX_SLOT) note = p.slotNames[n] ?? '';
      else if (op === Op.GET_CAPTURED || op === Op.SET_CAPTURED) note = p.captureNames[n] ?? '';
      else if (op === Op.GET_BUILTIN) note = BUILTINS[n]?.name ?? '';
      return { offset, size: 2, op, text: `${pad}${String(n).padStart(4)} ${note}`.trimEnd() };
    }
    case 'u16': {
      const n = u16();
      let note = '';
      if (op === Op.CONST || op === Op.GET_FIELD || op === Op.SET_FIELD) note = constText(p, n);
      else if (op === Op.GET_GLOBAL || op === Op.SET_GLOBAL || op === Op.DEFINE_GLOBAL) note = globalNames[n] ?? '';
      return { offset, size: 3, op, text: `${pad}${String(n).padStart(4)} ${note}`.trimEnd() };
    }
    case 'jump': {
      const target = offset + 3 + u16();
      return { offset, size: 3, op, text: `${pad}-> ${hex(target)}` };
    }
    case 'loop': {
      const target = offset + 3 - u16();
      return { offset, size: 3, op, text: `${pad}-> ${hex(target)}` };
    }
    case 'closure': {
      const idx = u16();
      const proto = p.constants[idx] as FnProto;
      const caps: string[] = [];
      let at = offset + 3;
      for (let i = 0; i < proto.captureNames.length; i++) {
        const local = code[at] === 1;
        const n = code[at + 1]!;
        caps.push(`${proto.captureNames[i]}=${local ? 'slot' : 'captured'} ${n}`);
        at += 2;
      }
      const text = `${pad}${String(idx).padStart(4)} ${constText(p, idx)}${caps.length ? ' [' + caps.join(', ') + ']' : ''}`;
      return { offset, size: at - offset, op, text };
    }
  }
}

export function instructions(p: FnProto, globalNames: string[] = []): Instruction[] {
  const out: Instruction[] = [];
  for (let off = 0; off < p.code.length;) {
    const ins = decode(p, off, globalNames);
    out.push(ins);
    off += ins.size;
  }
  return out;
}

export function disassembleFn(p: FnProto, globalNames: string[] = []): string {
  const title = p.name === '<script>' ? '<script>' : `fn ${p.name ?? 'anonymous'}`;
  const lines = [`== ${title} (arity ${p.arity}, ${p.constants.length} constants, ${p.code.length} bytes) ==`];
  let lastLine = -1;
  for (const ins of instructions(p, globalNames)) {
    const pos = p.positions[ins.offset];
    let where = '     |';
    if (pos && pos.line !== lastLine) {
      where = `${pos.line}:${pos.col}`.padStart(6);
      lastLine = pos.line;
    }
    lines.push(`${hex(ins.offset)} ${where}  ${ins.text}`);
  }
  return lines.join('\n');
}

/** Disassemble a whole program: the script first, then every nested function. */
export function disassemble(program: Program): string {
  const parts: string[] = [];
  const visit = (p: FnProto) => {
    parts.push(disassembleFn(p, program.globalNames));
    for (const c of p.constants) if (isProto(c)) visit(c);
  };
  visit(program.main);
  return parts.join('\n\n') + '\n';
}
