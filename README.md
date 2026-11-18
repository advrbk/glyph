# Glyph

Glyph is a small, dynamically typed scripting language written from scratch in TypeScript. It has a hand-written lexer, a Pratt parser, a resolver that catches scope errors before the program runs, a constant-folding pass, a compiler to compact bytecode, and a stack-based virtual machine with call frames and closures. A separate tree-walking interpreter runs the same programs, and a differential fuzzer checks that the two engines agree on thousands of random programs. There is a command-line tool (`run`, `repl`, `dis`) and a browser playground that can step through the VM one instruction at a time.

```
fn counter(start) {
  let count = start
  fn() {
    count += 1
    count
  }
}

let next = counter(10)
next()
print("next is {next()}")                                    # next is 12

let scores = [72, 95, 58, 88]
let passed = scores |> filter(fn(s) => s >= 65) |> map(fn(s) => s + 5)
print(passed, reduce(passed, fn(a, b) => a + b, 0))           # [77, 100, 93] 270
```

## Quick start

Developed and tested with Node 24 and npm 11. The only dependencies are development tools (TypeScript, tsx, esbuild, Vitest).

```bash
npm install
npm run build                          # dist/glyph.js (CLI) and playground/dist/

node dist/glyph.js run examples/closures.gly
node dist/glyph.js run examples/fib.gly --tree --stats   # tree-walker, with timing
node dist/glyph.js dis examples/fib.gly                  # print the bytecode
node dist/glyph.js repl
```

`npm run glyph -- run examples/life.gly` runs the TypeScript sources directly without building.

The playground is static: open `playground/dist/index.html` in a browser (no server needed, it works offline). The built files in `playground/dist/` are committed so the playground works straight from a clone; `npm run build` regenerates them. It has an editor, example programs, a Run button for either engine, the bytecode listing, and a debugger that steps through the VM showing the next instruction, the call frames and the value stack.

Errors point at the source:

```
runtime error: cannot apply '+' to string and number (use ++ to join strings)
 --> examples/oops.gly:2:17
  |
2 | print("count: " + count)
  |                 ^
```

## Language tour

Comments start with `#`. Statements end at a line break or `;`. A line that starts with `(`, `[` or `-` begins a new statement; a line that starts with any other operator (`+`, `|>`, `and`, ...) continues the previous one. Inside parentheses the same rule applies, so `(a` followed by a line `- b)` is a syntax error; put the `-` at the end of the first line instead. Names are ASCII letters, digits and `_`; strings may hold any Unicode text.

### Values and variables

```
let n = 42                # numbers are 64-bit floats
let s = "text"
let ok = true
let nothing = nil
const PI = 3.14159        # const cannot be reassigned
n += 1                    # also -= *= /= %= and ++= for strings
```

Only `false` and `nil` are falsy. `+ - * / %` work on numbers only; `++` joins two strings or two arrays. Dividing by zero is an error. `==` compares numbers, strings, booleans and nil by value, and arrays, maps and functions by identity.

### Strings

```
let name = "Ada"
print("hello, {name}! 2 + 2 = {2 + 2}")    # any expression inside { }
print("braces: \{ \}, quote: \", newline: \n")
print(len(name), name[0], slice(name, 1, 3), split("a,b", ","), join([1, 2], "-"))
```

### Blocks and control flow

`if` and `do` blocks are expressions; a block's value is its last expression.

```
let size = if n > 100 { "big" } else if n > 10 { "medium" } else { "small" }
let area = do {
  let w = 3
  let h = 4
  w * h
}

while n > 0 {
  n -= 10
  if n == 12 { continue }
  if n < 5 { break }
}

for i in 0..5 { print(i) }          # 0 1 2 3 4
for i in 1..=3 { print(i) }         # 1 2 3 (range ends are integers within +/-2^53)
for x in [10, 20] { print(x) }
for ch in "hey" { print(ch) }
for key in {a: 1, b: 2} { print(key) }
```

### Functions and closures

```
fn add(a, b) => a + b                # expression body
fn fact(n) {                         # block body; the last expression is returned
  if n <= 1 { return 1 }
  n * fact(n - 1)
}
const square = fn(x) => x * x        # functions are values

fn makeAdder(k) => fn(x) => x + k
print(makeAdder(10)(5))              # 15
```

Closures capture variables, not copies, and every loop iteration has its own loop variable:

```
let fs = []
for i in 0..3 { push(fs, fn() => i) }
print(map(fs, fn(f) => f()))          # [0, 1, 2]
```

Functions declared in the same block can call each other in any order (`examples/mutual.gly`).

### Arrays and maps

```
let xs = [3, 1, 2]
xs[0] = 9
push(xs, 4)
print(xs, len(xs))
print(pop(xs), xs)

let book = {title: "Dune", "page count": 412, [name]: true}
book.year = 1965                      # add or change a key
print(book.title, book["page count"], book["missing"])   # missing key with [] gives nil
print(keys(book), has(book, "year"))
```

`book.missing` (field syntax) is an error, so typos in field names are caught; `book["missing"]` returns `nil`. Keywords work as keys in both forms: `{if: 1}.if`.

### The pipe operator

`a |> f(b)` means `f(a, b)`, and `a |> f` means `f(a)`:

```
let total = 1..=10 |> filter(fn(x) => x % 2 == 0) |> map(fn(x) => x * x) |> reduce(fn(a, b) => a + b, 0)
```

### Standard library

| Function | What it does |
|---|---|
| `print(...)` | print values separated by spaces |
| `len(x)` | length of a string, array, map or range |
| `push(arr, v)`, `pop(arr)` | add to / remove from the end of an array |
| `keys(map)`, `has(map, key)` | map keys in insertion order; key test |
| `map(xs, f)`, `filter(xs, f)`, `reduce(xs, f, init)` | over arrays and ranges |
| `str(v)`, `num(s)`, `type(v)` | to string; parse a number (`nil` if invalid); type name |
| `floor`, `round`, `abs`, `sqrt`, `min(a, b)`, `max(a, b)` | numbers |
| `join(arr, sep)`, `split(s, sep)`, `slice(x, from, to)` | strings and arrays |
| `clock()` | seconds since start, for timing |
| `assert(cond, msg?)`, `error(msg)` | raise a runtime error |

### Errors

Syntax and compile errors are reported before anything runs, all at once:

```
compile error: cannot use 'limit' before its definition
 --> main.gly:1:7
  |
1 | print(limit)
  |       ^
```

The resolver reports undefined names, use before definition, assignment to a `const`, a function, a loop variable or a builtin, duplicate names, and `return`, `break` or `continue` outside a function or loop. `tests/errors/` has one example of every error message with its exact output.

## How it is built

```
source -> lexer -> tokens -> Pratt parser -> AST -> resolver -> constant folder -> compiler -> bytecode -> VM
                                                        \
                                                         -> tree-walking interpreter (reference)
```

- The lexer splits interpolated strings into parts, so the parser never looks inside a string.
- The parser is a Pratt parser with a binding-power table. `|>` and `fn(x) => e` are desugared there.
- The resolver links names to declarations, hoists declarations so functions can be mutually recursive, reports scope errors, and works out which variables closures capture.
- The compiler emits one-byte opcodes (56 of them) with one- or two-byte operands, plus a position table so every runtime error has a line and column. It tracks the exact stack depth after each instruction, which lets blocks with local variables appear in the middle of expressions.
- Captured variables live in heap boxes, decided at compile time. A loop body is a fresh block each iteration, so closures made in different iterations get different variables. Variables no closure captures are plain stack slots.
- The VM keeps its hot state in local variables and runs a `switch` over the opcodes. `run(budget)` can stop after any number of instructions, which is how the playground single-steps.
- `map`, `filter` and `reduce` are generators that ask the VM to run their callbacks as ordinary frames, so the VM never re-enters itself.

`docs/HOW_IT_WORKS.md` walks one program through every stage with the real tokens, AST, bytecode and a VM trace, and ends with interview questions and answers.

## Tests

```bash
npm test                 # 150 tests in 10 files, about 25 s
npm run typecheck
npm run fuzz             # 20,000 random programs by default; --seeds N --from S
npm run mutation-check   # plants bugs and checks the fuzzer catches them (about 2 min)
```

| File | What it checks |
|---|---|
| `tests/differential-a.test.ts`, `-b` | 5,000 random programs (fixed seeds 0 to 4,999), each run on the VM with folding, the VM without folding and the tree-walker. Output and errors must match exactly and the VM stack must be empty afterwards. |
| `tests/golden.test.ts` | the 11 example programs against their `.out` files, and 38 error programs in `tests/errors/` against `.err` snapshots, on all three engine configurations |
| `tests/semantics.test.ts` | operators, scope, closures (loop capture, nested capture, captured parameters), recursion, loops, collections and the standard library, all checked on both engines |
| `tests/lexer.test.ts`, `tests/parser.test.ts` | tokens, interpolation, positions, precedence, associativity, line-break rules and syntax error messages |
| `tests/tools.test.ts` | constant folding rules, the disassembler, opcode numbering, the REPL |
| `tests/depth.test.ts` | both engines reach the 1000-call limit and report a stack overflow the same way |
| `tests/robustness.test.ts` | cases found by hand-written adversarial programs in review: huge ranges, printing 100,000-deep nested values, strings past the JS length limit, absurdly deep nesting, a byte order mark, emoji in error messages, keyword field names, a compile-time limit in the REPL |
| `tests/playground.test.ts` | the playground bundle builds, stays under 200 KB and loads nothing from the network |

### Differential fuzzing results

Each program is run three ways: on the VM with constant folding, on the VM without it, and on the tree-walker. A program "agrees" when all three print exactly the same lines and stop with the same error message at the same line and column (or all finish normally).

| Run | Programs | All three agreed | Of those, ended in a runtime error | Skipped (hit the fuel limit) | Disagreed |
|---|---:|---:|---:|---:|---:|
| `npm test` (seeds 0 to 4,999) | 5,000 | 5,000 | 2,205 | 0 | 0 |
| `npm run fuzz -- --seeds 50000` (seeds 1,000,000 to 1,049,999) | 50,000 | 49,994 | 21,975 | 6 | 0 |
| review, before its fixes (seeds 73,000,000 to 73,011,999) | 12,000 | 11,999 | 5,247 | 1 | 0 |
| review, after its fixes (seeds 91,000,000 to 91,011,999) | 12,000 | 11,998 | 5,163 | 2 | 0 |

The 50,000-program run executed 82 million VM instructions and took 259 seconds. About 44% of the programs end in a deliberate or accidental runtime error (an index past the end, a missing key, division by zero, a forward reference used too early), so the error paths and positions are compared as often as normal output. The Limitations section says what this costs in coverage.

### Mutation check

To check that the fuzzer can catch real bugs, `npm run mutation-check` plants one bug at a time in the source, runs 600 random programs in a fresh process and puts the file back:

| Planted bug | Programs that disagreed (of 600) |
|---|---:|
| compiler: a captured loop variable is never put in a box | 202 |
| compiler: `break` pops one value too few | 35 |
| compiler: a block drops its value instead of keeping it above its locals | 575 |
| VM: block-local boxes reused across loop iterations (the classic closure-in-a-loop bug) | 384 |
| VM: `or` treats `nil` as true | 206 |
| VM: the forward-reference check removed from captured reads | 18 |
| VM: a range loop stops one item early | 110 |
| folder: swaps the result of `or` with a literal left side | 53 |
| folder: turns `if false { a }` (no else) into `a` instead of `nil` | 89 |
| tree-walker: `a[i] += f()` reads the old value after calling `f` | 113 |
| shared `ops.ts`: `%` takes the sign of the divisor | 0 |

10 of 11 were caught. The last one is in code both engines share, so they agree on the wrong answer; the semantics tests catch it (`-7 % 3` must be `-1`).

### What testing found

The fuzzer finds no disagreements between the engines in their current state. Testing and profiling found these problems during development, and all of them are fixed:

- A grammar problem, found by the fuzzer. A line starting with `-` continued the previous statement, so generated code such as `let v = a` followed by a line `-(v + 1)` was parsed as `let v = a - (v + 1)`. Now `-`, `(` and `[` at the start of a line begin a new statement; other operators at the start of a line still continue the previous one.
- A stack-depth mismatch, found by a semantics test. Under the test runner, the tree-walker ran out of JS stack before the language's 1000-call limit (the VM printed 900, the tree-walker reported a stack overflow). Fixed by using fewer and smaller JS frames per Glyph call and running the tree-walker with a larger stack; `tests/depth.test.ts` now checks four deeply nested shapes.
- Two generator traps that made fuzz runs hang: looping over an array while something pushes to it, and a function that grows an outer array being called from `map` over that array. The generator now avoids both, and every run has an instruction budget and a wall-clock limit.
- Two performance bugs, found by profiling. The first VM loop kept its registers in variables captured by a helper closure, which roughly halved its speed. The tree-walker checked the clock on every evaluation step when no fuel limit was set.

A later review with hand-written adversarial programs found problems that the generator never produces, all now fixed and covered by `tests/robustness.test.ts`:

- Ranges past 2^53. A double cannot count by one there (`2^53 + 1 == 2^53`), so the VM repeated an item and the tree-walker looped forever on the same range. Range ends are now limited to +/-9,007,199,254,740,991. This was a real disagreement between the engines.
- Host limits. Doubling a string until it passed JavaScript's maximum length crashed the VM with a JS `RangeError`, and the tree-walker reported it as "stack overflow (more than 1000 nested calls)" because it treated every `RangeError` as deep recursion. Both now report `string is too long` at the same position.
- Printing a deeply nested value (a 100,000-deep list) overflowed the JS stack in both engines. `display` now walks containers with an explicit stack.
- Absurdly deep source (100,000 nested parentheses, or a 100,000-term sum) crashed the recursive parser, resolver or compiler with a JS stack trace. It is now a normal error.
- Smaller fixes: a UTF-8 byte order mark at the start of a file was rejected; "unexpected character" printed half of an emoji; `{if: 1}` was accepted but `.if` was a syntax error; a compile-time limit (more than 255 arguments) crashed the REPL.

## Benchmarks

```bash
npm run bench            # -- --runs N to change the number of timed runs
```

The benchmark builds the library bundle (the same code `dist/glyph.js` runs) and times each program in `bench/` on the tree-walker, on the VM, and on the VM with constant folding turned off. Runs are interleaved so changes in background load hit every engine alike, and all three must print the same output. Each cell below is the median of 5 runs (`npm run bench -- --runs 5`; the default is 3); a run longer than 2.5 s is timed once.

Measured on an Intel Core i7-6820HQ laptop (2016, 4 cores), Node 24.21, Windows 11, while another job was using part of the CPU. One run:

| Program | What it does | Tree-walker ms | VM ms | VM speedup | VM without folding ms | VM instructions, folding off -> on |
|---|---|---:|---:|---:|---:|---|
| fib | `fib(30)`, about 1.6 million calls | 2,170 | 568 | 3.8x | 590 | 30.96M -> 30.96M |
| loops | nested `for`/`while`, one million inner iterations | 1,035 | 245 | 4.2x | 274 | 19.01M -> 19.01M |
| strings | builds a 200,000-character string with `++=` and interpolation, then scans it | 342 | 103 | 3.3x | 110 | 6.00M -> 6.00M |
| closures | 200,000 calls through composed closures and a counter | 464 | 139 | 3.3x | 149 | 7.61M -> 7.61M |
| pipeline | `map` / `filter` / `reduce` with small lambdas | 205 | 100 | 2.0x | 98 | 1.71M -> 1.71M |
| constants | physics loop written with named constants | 898 | 258 | 3.5x | 338 | 14.88M -> 13.68M (8% fewer) |

A second run gave VM speedups of 3.5x, 3.6x, 2.7x, 3.3x, 2.0x and 3.2x for the same rows, so treat the timings as rough (plus or minus 10 to 20%); the instruction counts are exact and the same every run.

A later review re-ran the benchmark twice on the same laptop while two other builds were running, so every absolute time was 1.5 to 2 times higher (fib: 3,699 ms tree-walker against 981 ms VM, then 3,429 against 1,245). The ratios stayed in the same band: VM speedups of 2.1x to 4.9x in the first run and 2.1x to 3.7x in the second, with `pipeline` lowest both times. Only the ratios and the instruction counts are meaningful on a shared machine.

How to read it:

- The VM is roughly 2 to 4 times faster than the tree-walker (2.0x to 4.9x across the four runs above). The gap is largest where the work is variable access and arithmetic, because the VM reads locals by slot index while the tree-walker looks names up in a chain of maps.
- `pipeline` gains least: most of its time is spent inside `map`, `filter` and `reduce` resuming their generators and calling back into Glyph, and both engines share that code.
- Constant folding only changes code that has constant expressions. On `constants` it removes 8% of the executed instructions; the measured time gain was 1.31x in this run and 1.07x in the second. On the other programs it changes no instructions at all, and the differences in the "without folding" column (0.91x to 1.12x across both runs) are measurement noise.

## Project layout

```
src/
  lexer.ts parser.ts ast.ts      front end
  resolver.ts                    scopes, compile errors, capture analysis
  fold.ts                        constant folding
  bytecode.ts compiler.ts        bytecode format and compiler
  vm.ts                          the virtual machine
  interp.ts                      tree-walking reference interpreter
  values.ts ops.ts stdlib.ts     runtime values, operators, builtins (shared)
  disasm.ts                      disassembler
  errors.ts                      errors and caret formatting
  glyph.ts cli.ts repl.ts        API, command line, REPL
  fuzz/generate.ts               random program generator
  fuzz/differential.ts           three-way comparison harness
  playground/                    browser playground (built into playground/dist/)
examples/      example programs with expected output (.out)
tests/         Vitest tests; tests/errors/ holds the error snapshots
bench/         benchmark programs
scripts/       build, bench, fuzz, mutation-check
docs/          HOW_IT_WORKS.md
```

## Limitations

- It is slow next to production VMs. The VM is a `switch` loop in JavaScript with no JIT, no inline caches and no superinstructions; numbers are JS doubles and values are JS values, so memory is managed by the JS garbage collector.
- There are no tail calls. Recursion is limited to 1000 nested calls in both engines.
- The constant folder is the only optimisation, and it helps little on code without constant expressions (see the benchmark table).
- The differential fuzzer cannot find bugs in code both engines share: the lexer, parser, resolver, the operator functions in `ops.ts` and the standard library. Those are covered by the unit and golden tests only. The mutation check shows this blind spot directly.
- The generated programs are small (about 1,600 VM instructions each on average) and use a fixed set of shapes, so bugs that need long or unusual programs can be missed. The review findings listed above are examples: none of them can come out of the generator.
- About 43% of generated programs stop with a runtime error, on average a third of the way through the program. Those errors are compared (message, line and column), but the code after them is not run, so an error-ending program exercises fewer instructions (a median of about 360 against about 1,100 for one that finishes). Every one of the 56 opcodes still runs in most programs: in a sample of 1,500, closure opcodes ran in over 85% of programs and map opcodes in all of them.
- The compiler has limits the tree-walker does not (256 locals and 255 arguments per function, 65,536 constants, 65,535 array items in one literal). A program past them is a compile error on the VM and runs on the tree-walker. The fuzzer never generates such programs.
- The tree-walker uses the JS stack. It needs Node started with `--stack-size=4000` to be sure of reaching the 1000-call limit in deeply nested code; the test runner, the fuzzer and `glyph run --tree` do this. In a browser the stack is smaller, so the playground's tree-walker can report a stack overflow earlier than the VM.
- Strings are UTF-16 code units, so `len` and indexing count code units, not characters.
- There are no modules, no classes, no exceptions that programs can catch, and no file or network access.
- The playground editor is a plain textarea without syntax highlighting.

## License

MIT, see `LICENSE`.
