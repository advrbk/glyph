// The bytecode format. Each function compiles to an FnProto: a Uint8Array of
// one-byte opcodes followed by their operands (u8 or big-endian u16), a
// constant pool, and a table mapping each instruction's offset to a source
// position for error messages.

import type { Pos } from './errors.js';
import type { Value } from './values.js';

export enum Op {
  CONST, // u16 constant index
  NIL,
  TRUE,
  FALSE,
  POP,
  POPN, // u8 count
  POP_UNDER, // u8 count: keep the top value, drop `count` values below it
  DUP,
  DUP2,

  PUSH_BOX, // push a fresh box for a captured local (holds "uninitialized")
  GET_LOCAL, // u8 slot
  SET_LOCAL, // u8 slot (assignment: leaves the value on the stack)
  INIT_LOCAL, // u8 slot (declaration: pops the value)
  GET_BOX, // u8 slot holding a box
  SET_BOX,
  INIT_BOX,
  BOX_SLOT, // u8 slot: wrap the value already in the slot in a new box
  GET_CAPTURED, // u8 index into the closure's captured boxes
  SET_CAPTURED,
  GET_GLOBAL, // u16
  SET_GLOBAL,
  DEFINE_GLOBAL,
  GET_BUILTIN, // u8

  ADD,
  SUB,
  MUL,
  DIV,
  MOD,
  CONCAT,
  NEG,
  NOT,
  EQ,
  NE,
  LT,
  LE,
  GT,
  GE,
  RANGE,
  RANGE_INCL,

  JUMP, // u16 forward offset
  JUMP_IF_FALSE, // u16, pops the condition
  JUMP_IF_FALSE_KEEP, // u16, keeps the value (for 'and')
  JUMP_IF_TRUE_KEEP, // u16, keeps the value (for 'or')
  LOOP, // u16 backward offset

  CALL, // u8 argument count
  RETURN,
  CLOSURE, // u16 proto constant, then 2 bytes per capture: (1 = local slot | 0 = captured index), u8 index

  ARRAY, // u16 count
  MAP, // u16 pair count
  GET_INDEX,
  SET_INDEX,
  GET_FIELD, // u16 name constant
  SET_FIELD, // u16 name constant
  INTERP, // u8 part count

  ITER_INIT,
  ITER_NEXT, // u16 forward offset taken when the iterator is finished
}

export type OperandShape = 'none' | 'u8' | 'u16' | 'jump' | 'loop' | 'closure';

export const OPERANDS: Record<Op, OperandShape> = {
  [Op.CONST]: 'u16', [Op.NIL]: 'none', [Op.TRUE]: 'none', [Op.FALSE]: 'none', [Op.POP]: 'none',
  [Op.POPN]: 'u8', [Op.POP_UNDER]: 'u8', [Op.DUP]: 'none', [Op.DUP2]: 'none',
  [Op.PUSH_BOX]: 'none', [Op.GET_LOCAL]: 'u8', [Op.SET_LOCAL]: 'u8', [Op.INIT_LOCAL]: 'u8',
  [Op.GET_BOX]: 'u8', [Op.SET_BOX]: 'u8', [Op.INIT_BOX]: 'u8', [Op.BOX_SLOT]: 'u8',
  [Op.GET_CAPTURED]: 'u8', [Op.SET_CAPTURED]: 'u8',
  [Op.GET_GLOBAL]: 'u16', [Op.SET_GLOBAL]: 'u16', [Op.DEFINE_GLOBAL]: 'u16', [Op.GET_BUILTIN]: 'u8',
  [Op.ADD]: 'none', [Op.SUB]: 'none', [Op.MUL]: 'none', [Op.DIV]: 'none', [Op.MOD]: 'none',
  [Op.CONCAT]: 'none', [Op.NEG]: 'none', [Op.NOT]: 'none', [Op.EQ]: 'none', [Op.NE]: 'none',
  [Op.LT]: 'none', [Op.LE]: 'none', [Op.GT]: 'none', [Op.GE]: 'none',
  [Op.RANGE]: 'none', [Op.RANGE_INCL]: 'none',
  [Op.JUMP]: 'jump', [Op.JUMP_IF_FALSE]: 'jump', [Op.JUMP_IF_FALSE_KEEP]: 'jump',
  [Op.JUMP_IF_TRUE_KEEP]: 'jump', [Op.LOOP]: 'loop',
  [Op.CALL]: 'u8', [Op.RETURN]: 'none', [Op.CLOSURE]: 'closure',
  [Op.ARRAY]: 'u16', [Op.MAP]: 'u16', [Op.GET_INDEX]: 'none', [Op.SET_INDEX]: 'none',
  [Op.GET_FIELD]: 'u16', [Op.SET_FIELD]: 'u16', [Op.INTERP]: 'u8',
  [Op.ITER_INIT]: 'none', [Op.ITER_NEXT]: 'jump',
};

export class FnProto {
  code: Uint8Array = new Uint8Array(0);
  readonly constants: (Value | FnProto)[] = [];
  /** Source position of the instruction starting at each offset. */
  readonly positions: (Pos | undefined)[] = [];
  /** Names of the captured variables, for error messages and the debugger. */
  readonly captureNames: string[] = [];
  /** Names of local slots (by slot number) for the debugger. */
  readonly slotNames: string[] = [];
  maxStack = 0;

  constructor(
    readonly name: string | null,
    readonly arity: number,
  ) {}
}

/** Prototypes live in the constant pool of the function that creates them. */
export function isProto(v: unknown): v is FnProto {
  return v instanceof FnProto;
}

export interface Program {
  main: FnProto;
  /** Names of all globals known to this program (index = global slot). */
  globalNames: string[];
}
