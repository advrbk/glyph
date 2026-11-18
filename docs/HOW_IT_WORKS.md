# How Glyph works

This guide follows one small program through every stage of the implementation, then explains the parts that need the most care (closures, the optimisation, and how the two engines are checked against each other). It ends with questions an interviewer is likely to ask, with short answers. File names refer to `src/`.

## 1. The pipeline

```
source text
   |  lexer.ts        characters -> tokens (string interpolation is split here)
   v
tokens
   |  parser.ts       Pratt parser -> AST
   v
AST
   |  resolver.ts     names -> declarations, compile errors, which variables closures capture
   v
resolved AST ----------------------------+
   |  fold.ts         constant folding   |   (optional; the result is a new tree)
   v                                     v
   |  compiler.ts     AST -> bytecode    interp.ts   tree-walking interpreter
   v                                     (the reference implementation)
bytecode (FnProto per function)
   |  vm.ts           stack machine with call frames
   v
output
```

The lexer, parser and resolver are shared. After that there are two independent back ends: the bytecode compiler plus VM, and the tree-walker. The differential fuzzer runs the same program through the VM with folding, the VM without folding, and the tree-walker, and requires identical output and identical errors.

## 2. One program, start to finish

```
fn makeCounter(step) {
  let count = 0
  fn() {
    count += step
    count
  }
}
const tick = makeCounter(2)
tick()
print("count is {tick()}")
```

It prints `count is 4`. `makeCounter` returns a closure that remembers `count` and `step` after `makeCounter` has returned.

### 2.1 Tokens

`lex()` produces a flat array. Each token has a type, its text, its line and column, and a flag that says whether a line break came before it (`nl`):

```
kw fn @1:1 nl
ident makeCounter @1:4
punct ( @1:15
ident step @1:16
punct ) @1:20
punct { @1:22
kw let @2:3 nl
...
ident print @10:1 nl
punct ( @10:6
strStart "count is " @10:7
ident tick @10:18
punct ( @10:22
punct ) @10:23
strEnd "" @10:24
punct ) @10:26
eof @11:1
```

The interesting part is the string. When the lexer reaches `{` inside a string, it emits the text so far as `strStart`, pushes an entry on a small stack, and goes back to lexing ordinary tokens. Each `{` and `}` inside the interpolation adjusts a depth counter on that entry; the `}` that brings it back to zero resumes the string and produces `strMid` or `strEnd`. The stack is what makes nested cases work: `"a {f({k: "b {1}"})} c"` lexes correctly. The parser never has to look inside a string.

Operators are matched longest first (`..=` before `..`, `++=` before `++`), and a number only takes a `.` if a digit follows, so `1..5` is `1`, `..`, `5`.

### 2.2 AST

`parse()` builds the tree. Printed as an s-expression (the tests use this format):

```
{(fndecl makeCounter (fn (step) {(let count 0) (fn () {(+= count step) count})}))
 (const tick (call makeCounter 2))
 (call tick)
 (call print (interp "count is " (call tick) ""))}
```

The parser is a Pratt parser. Every token that can start an expression has a prefix rule (`prefix()`: literals, names, `(`, `[`, `{`, `-`, `not`, `fn`, `if`, `do`). Every token that can continue an expression has a binding power (`infixPower()`):

| Power | Operators | Associativity |
|---:|---|---|
| 1 | `=` `+=` `-=` `*=` `/=` `%=` `++=` | right |
| 2 | `\|>` | left |
| 3 | `or` | left |
| 4 | `and` | left |
| 5 | `==` `!=` | cannot be chained |
| 6 | `<` `<=` `>` `>=` | cannot be chained |
| 7 | `..` `..=` | cannot be chained |
| 8 | `++` | left |
| 9 | `+` `-` | left |
| 10 | `*` `/` `%` | left |
| 11 | unary `-`, `not` | prefix |
| 12 | call `(`, index `[`, field `.` | postfix |

`expr(minPower)` parses a prefix expression, then keeps folding infix operators into it while their power is at least `minPower`. A left-associative operator parses its right side with `power + 1`; assignment parses its right side with the same power, which makes it right-associative. Chained comparisons (`a < b < c`) are a syntax error rather than a silent surprise.

Some sugar is removed in the parser. `a |> f(b)` becomes the call `f(a, b)`, and `fn(x) => e` becomes a function whose body is a block holding the single expression `e`.

Line breaks matter in two places. A statement must end at a line break, `;` or `}`. And `(`, `[` and `-` at the start of a line begin a new statement instead of calling, indexing or subtracting from the previous line. Every other infix operator at the start of a line continues the previous line, so pipelines can be split over lines.

### 2.3 Resolution

`resolve()` walks the tree once and links every name to a `Decl` object (or to a builtin). Along the way it reports compile errors with positions: undefined names, use before definition, assignment to a constant, a function, a loop variable or a builtin, duplicate declarations and parameters, and `return`, `break` or `continue` in the wrong place. It collects all of them rather than stopping at the first.

Declarations are hoisted to the top of their block. That is what lets two functions in the same block call each other. The rule for using a hoisted name before its declaration is:

- in the same function (straight-line code): a compile error, because that code always runs before the declaration;
- from a nested function: allowed, because the call usually happens later. If it does not, it is a runtime error, `'x' was used before its definition ran`.

The resolver also decides where each variable lives. Top-level declarations become globals (numbered slots in a global array). Everything else is a local of the function that declares it. When a function refers to a local of an enclosing function, the resolver marks that `Decl` as captured and adds it to the capture list of every function between the use and the declaration. In the example, `count` and `step` are locals of `makeCounter`, both captured by the anonymous function.

### 2.4 Bytecode

`compileProgram()` turns each function into an `FnProto`: a `Uint8Array` of one-byte opcodes and their operands, a constant pool, and a table from instruction offset to source position. `glyph dis` prints it:

```
== <script> (arity 0, 3 constants, 38 bytes) ==
0000    1:1  CLOSURE            0 <fn makeCounter>
0003      |  DEFINE_GLOBAL      0 makeCounter
0006   8:14  GET_GLOBAL         0 makeCounter
0009      |  CONST              1 2
0012      |  CALL               1
0014      |  DEFINE_GLOBAL      1 tick
0017    9:1  GET_GLOBAL         1 tick
0020      |  CALL               0
0022      |  POP
0023   10:1  GET_BUILTIN        0 print
0025      |  CONST              2 "count is "
0028      |  GET_GLOBAL         1 tick
0031      |  CALL               0
0033      |  INTERP             2
0035      |  CALL               1
0037    1:1  RETURN

== fn makeCounter (arity 1, 2 constants, 18 bytes) ==
0000   1:16  BOX_SLOT           0 step
0002      |  PUSH_BOX
0003   2:15  CONST              0 0
0006      |  INIT_BOX           1 count
0008    3:3  CLOSURE            1 <fn anonymous> [count=slot 1, step=slot 0]
0015   1:22  POP_UNDER          1
0017      |  RETURN

== fn anonymous (arity 0, 0 constants, 11 bytes) ==
0000    4:5  GET_CAPTURED       0 count
0002      |  GET_CAPTURED       1 step
0004      |  ADD
0005      |  SET_CAPTURED       0 count
0007      |  POP
0008    5:5  GET_CAPTURED       0 count
0010    3:8  RETURN
```

There are 56 opcodes. Operands are one byte (slots, argument counts) or two bytes big-endian (constant indexes, globals, jump offsets). The listing shows the source position only when the line changes.

Things worth noticing in `makeCounter`:

- Slots are reserved when a block starts. `PUSH_BOX` runs before `let count = 0`. Every name a block declares gets its slot when the block is entered (a `NIL`, or a fresh box if a closure captures it), and `let` only stores into it (`INIT_BOX`). Reserving early is what lets a closure capture a variable that is declared later in the same block.
- Captured parameters are boxed on entry. `step` arrives as a plain value in slot 0; `BOX_SLOT 0` wraps it in a box because the closure captures it.
- Blocks are expressions. The body's value (the closure) is on top of the stack, above the one reserved slot. `POP_UNDER 1` drops the slot and keeps the value.

Because blocks are expressions (`1 + do { let t = 2; t }`), locals can sit above temporaries on the stack. So the compiler cannot just count locals; it tracks the exact stack depth after every instruction. Each `op()` call adds the instruction's stack effect, and every block checks at the end that it left the stack exactly one higher (as an expression) or unchanged (as a statement). If the check fails, the compiler throws an internal error. `break`, `continue` and `return` use the tracked depth to know how many values to pop before jumping.

### 2.5 Execution

The VM (`vm.ts`) has one value stack shared by all frames and a frame stack. A frame records its closure, its instruction pointer and its `base` (the stack index of slot 0; the callee sits just below it). The hot registers (code, ip, base, sp, constants, captured boxes) are local variables of `run()` and are written back to the frame object only on calls and returns.

The trace below is one line per instruction, with the stack after it. Function values are shown by name, and `box(x)` is a box holding `x`:

```
<script>     CONST              1 2                | <script>  makeCounter  2
<script>     CALL               1                  | <script>  makeCounter  2
makeCounter  BOX_SLOT           0 step             | <script>  makeCounter  box(2)
makeCounter  PUSH_BOX                              | <script>  makeCounter  box(2)  box(uninit)
makeCounter  CONST              0 0                | <script>  makeCounter  box(2)  box(uninit)  0
makeCounter  INIT_BOX           1 count            | <script>  makeCounter  box(2)  box(0)
makeCounter  CLOSURE            1 <fn anonymous>   | <script>  makeCounter  box(2)  box(0)  <fn>
makeCounter  POP_UNDER          1                  | <script>  makeCounter  box(2)  <fn>
makeCounter  RETURN                                | <script>  <fn>
<script>     DEFINE_GLOBAL      1 tick             | <script>
<script>     GET_GLOBAL         1 tick             | <script>  <fn>
<script>     CALL               0                  | <script>  <fn>
anonymous    GET_CAPTURED       0 count            | <script>  <fn>  0
anonymous    GET_CAPTURED       1 step             | <script>  <fn>  0  2
anonymous    ADD                                   | <script>  <fn>  2
anonymous    SET_CAPTURED       0 count            | <script>  <fn>  2
anonymous    POP                                   | <script>  <fn>
anonymous    GET_CAPTURED       0 count            | <script>  <fn>  2
anonymous    RETURN                                | <script>  2
...
<script>     INTERP             2                  | <script>  print  "count is 4"
<script>     CALL               1                  | <script>  nil        (prints "count is 4")
<script>     RETURN                                |
```

`CALL 1` checks the arity, pushes a frame whose base is the first argument, and switches the registers. `CLOSURE` reads the capture list that follows its operand: `count=slot 1` means "the box in my slot 1". The new closure holds references to the two boxes, so when `makeCounter` returns and its slots are popped, the boxes live on inside the closure. `RETURN` takes the top value, cuts the stack back to the callee's position, pops the frame and pushes the value for the caller.

`run(budget)` executes at most `budget` instructions and returns `'paused'`, `'done'` or `'error'`. The CLI passes no budget. The playground passes 1 to single-step and 200,000 per animation frame to stay responsive, and the fuzzer passes a limit so a runaway program cannot hang it.

## 3. Closures and captured variables

### 3.1 Boxes, not open upvalues

A classic way to implement closures in a stack VM keeps captured variables on the stack while the function runs and moves ("closes") them to the heap when the function returns. Glyph uses a simpler scheme decided at compile time, often called assignment conversion:

- The resolver knows exactly which locals are captured.
- A captured local is stored in a heap `Box` from the moment its block starts. Its stack slot holds the box.
- The declaring function reads and writes it with `GET_BOX` / `SET_BOX`. A closure copies the box reference when it is created and uses `GET_CAPTURED` / `SET_CAPTURED`.
- A local that is never captured is a plain stack slot (`GET_LOCAL`), with no box and no extra cost.

Because the closure and the function share one box, writes are visible both ways. The cost is one allocation per captured variable per scope entry, and the box reference stays alive as long as any closure holds it. Nothing needs closing on return, so there is no list of open variables to search on every return.

### 3.2 Loop variables

```
let fs = []
for i in 0..3 { push(fs, fn() => i) }
print(map(fs, fn(f) => f()))      # [0, 1, 2]
```

Each iteration must give the closure its own `i`. In the bytecode a `for` loop keeps a hidden iterator in a slot. `ITER_NEXT` pushes the next item, which becomes the loop variable's slot, and if the loop variable is captured, `BOX_SLOT` wraps it in a new box right there:

```
ITER_INIT
ITER_NEXT       -> exit       ; push next item (the loop variable), or jump out
BOX_SLOT           1 i        ; a fresh box for this iteration
... body ...
POP                           ; drop the loop variable
LOOP            -> ITER_NEXT
```

Locals declared inside the loop body work the same way: the body is a block, so its slots, and the boxes in them, are created fresh each time the block is entered. A variable declared outside the loop has one box shared by every closure, which is also the intended semantics (`closures.gly` shows both).

### 3.3 Forward references

Hoisting makes `fn a() => b()` legal when `b` is declared later in the same block. For locals, the slot of `b` (with its box) is reserved when the block starts, so `a`'s closure can capture the box before `b` has a value. The box starts out holding a special `UNINIT` marker; `GET_CAPTURED` checks for it and reports `'b' was used before its definition ran` if `a` is called too early. Globals start as `UNINIT` too and `GET_GLOBAL` checks the same way. Reads inside the declaring function need no check, because the resolver has already rejected any read that could happen before the declaration.

## 4. Natives that call back into Glyph

`map`, `filter` and `reduce` call Glyph functions. If they were ordinary JS functions, the VM would have to call itself recursively to run the callback, which breaks single-stepping (the debugger would have to pause inside a JS call stack) and makes the call-depth limit harder to keep exact.

Instead these natives are JS generators. `map` yields `[callback, [item]]` and receives the result:

```ts
gen('map', 2, 2, function* ([xs, f]) {
  const out: Value[] = [];
  for (const x of items('map', xs!)) out.push(yield [f!, [x]] as CallRequest);
  return out;
}),
```

The VM pushes a `NativeFrame` holding the generator. When the generator asks for a call, the VM pushes an ordinary frame for the callback and goes back to its dispatch loop. When that frame returns and the frame below is a `NativeFrame`, the VM resumes the generator with the result. So a callback is just another frame: the debugger can step into it, errors inside it point at the callback's own code, and the depth limit counts it. The tree-walker drives the same generators with a plain loop.

## 5. The optimisation: constant folding

`fold.ts` runs on the resolved AST and returns a new tree, so the same parse can be compiled with and without it. It:

- evaluates operators whose operands are literals (`2 * 3.5`, `"a" ++ "b"`, `not true`, `1 < 2`, `-(4)`);
- replaces a reference to a constant whose value folded to a literal (`const DT = 1 / 240`) with that literal, then keeps folding (`G * DT` becomes one number);
- merges literal parts of interpolated strings (`"n={N}!"` with `const N = 3` becomes `"n=3!"`);
- removes the dead branch of an `if` with a literal condition and simplifies `and`/`or` with a literal left side.

It must not change behaviour, so:

- An operation that would fail (`1 / 0`, `"a" + 1`) is left in place and still fails at run time, at the same position. The folder runs the real operator inside `try` and gives up on an error.
- It never reassociates. `x * 2 * 3` is `(x * 2) * 3` and stays that way, because floating-point arithmetic is not associative. Only `2 * 3 * x` folds (to `6 * x`).
- It only substitutes a constant into references that come after the declaration in the source. A closure defined earlier might run before the constant exists, and that must still be a runtime error.
- Strings longer than 1,024 characters are not folded, so the constant pool cannot blow up.

The pass is measured three ways: the bytecode is smaller (the tests check that `W * H / 2` with two constants compiles to no `MUL` or `DIV`), fewer instructions run (`npm run bench` counts them), and the fuzzer runs every program with folding on and off and requires identical results. On `bench/constants.gly`, a physics loop written with named constants, folding removes 8% of the executed instructions (14.88 million down to 13.68 million); the measured speedup was between 1.07x and 1.31x over two runs on a loaded laptop. On code without constant expressions it changes nothing, and the benchmark table in the README shows that too.

## 6. Two engines and the differential fuzzer

### 6.1 The tree-walker

`interp.ts` evaluates the AST directly. It ignores the resolver's slot and capture annotations and keeps variables in a chain of `Env` objects (a `Map` per scope) looked up by name. A closure captures the `Env` it was created in. A loop body gets a new `Env` per iteration. `return`, `break` and `continue` are thrown as exceptions. It is written to be obviously correct rather than fast, and it shares only the front end (lexer, parser, resolver) and the operator and library functions with the VM.

It recurses on the JS stack, so it needs more stack than Node's default to reach the language's 1000-call limit in deeply nested code. The test runner, the fuzzer and `glyph run --tree` start Node with `--stack-size=4000`, and `tests/depth.test.ts` checks that both engines reach the limit on four kinds of deeply nested code.

### 6.2 The generator

`src/fuzz/generate.ts` writes random Glyph source text, so the lexer and parser are exercised too. It tracks a rough static type for every variable it declares (number, string, bool, array, map, function), which keeps most programs running for a while, and it follows the language's rules so every program compiles: names are declared before use, constants are never assigned, `break` only appears in loops. It produces nested functions and closures, closures created in loops, counter factories, recursion that counts down, forward references (sometimes called too early), `break`/`continue` in the middle of expressions, compound assignments whose right side changes the target, and blocks with closures inside expressions. A small fraction of operations are deliberately wrong (an index past the end, division by zero, a missing key, a wrong-typed operand) so the error paths are compared too.

Every loop is bounded and recursion always counts down. Two traps had to be designed out: looping over an array while something pushes to it never ends, so `for` loops iterate fresh copies and a function may only push to arrays it owns; and runs are capped by an instruction budget and a 5-second wall clock anyway.

### 6.3 The harness

`src/fuzz/differential.ts` runs each program three ways and compares every printed line and the final error (message, line and column). After a successful VM run it also checks that the value stack is empty, which tests the compiler's depth bookkeeping on every program. A JS exception inside an engine counts as a failure.

### 6.4 Does it catch bugs?

A fuzzer that never fails proves little unless it can fail. `npm run mutation-check` plants one bug at a time, runs 600 programs and restores the file. It catches 10 of 11 planted bugs: a captured loop variable never boxed, boxes shared between loop iterations, `break` popping one value too few, a block dropping its value, `or` treating `nil` as true, the forward-reference check removed, a range loop stopping early, the folder swapping a literal `or`, the folder turning `if false { a }` into `a`, and the tree-walker reading the old value in `a[i] += f()` too late. The one it misses is in shared code (`%` with the wrong sign), which both engines get wrong together; a unit test catches it instead (`-7 % 3` must be `-1`).

## 7. Errors and positions

Every error is a `GlyphError` with a kind (`syntax`, `compile`, `runtime`), a message and a position. Runtime helpers such as `ops.add` throw without a position, because they do not know which code called them. The VM catches the error, looks up the position of the instruction that was running (`proto.positions[start]`) and attaches it. The tree-walker attaches the position of the AST node it was evaluating. Both engines use the same convention for which token an error points at (the operator for arithmetic, the `(` for a call, the `[` for an index, the field name for a field), and the differential fuzzer checks that they agree. `formatError` prints the message, `file:line:col`, the source line and a caret.

## 8. Design decisions and trade-offs

- All numbers are doubles, as in JS and Lua. Integers print without a decimal point. Division by zero is an error rather than infinity, because a silent `inf` is more often a bug than an intention.
- `+` only adds numbers and `++` joins strings and arrays. There are no implicit conversions. Interpolation covers building strings from mixed values.
- Only `false` and `nil` are falsy. `0` and `""` are true, as in Ruby and Lua.
- Arrays and maps compare by identity, ranges by value. Structural equality on containers is easy to add but has cycles and cost to think about.
- Declarations are hoisted, with a static check. That allows mutual recursion and closures over later declarations without the surprises of JavaScript's `var`: reading a hoisted name too early is a compile error where it can be detected, and a runtime error where it cannot.
- Slot operands are one byte. At most 256 locals per function and 255 arguments; the compiler reports an error past that. Two-byte jump offsets limit a function body to 64 KB of bytecode.
- Strings are sequences of UTF-16 code units, as in JS: indexing and `len` count code units, not characters.

## 9. Likely interview questions

**Why have both a tree-walker and a VM?**
The tree-walker is short and easy to reason about, so it serves as the specification. The VM is faster but has more places to go wrong (stack depth, slot numbers, jump offsets, boxes). Running both on thousands of random programs and requiring identical output turns the simple one into a test oracle for the fast one.

**How fast is the VM compared with the tree-walker?**
Between 2x and 4x faster on the benchmarks in the README (for example 568 ms against 2,170 ms for `fib(30)`). The gap is largest on loops over local variables, where the VM reads slots by index while the tree-walker looks names up in a chain of maps. It is smallest on `map`/`filter`/`reduce` pipelines, where most of the time is spent in the generator-based builtins that both engines share. A tree-walker in JavaScript is not slow, because V8 optimises its recursive `eval` well; a bigger gap would need superinstructions, fewer allocations per call, or a register machine.

**How do closures capture variables, and why do loop closures work?**
The resolver finds every captured local. Those live in heap boxes from the moment their block starts; the stack slot holds the box and closures copy the box reference. Each loop iteration enters the body block again, so it creates new boxes, and the loop variable gets a new box from `BOX_SLOT` each iteration.

**What is a Pratt parser and why use one?**
It parses expressions with one loop and a table of binding powers instead of one grammar function per precedence level. Adding an operator is one table entry, and associativity is a choice between `power` and `power + 1` for the right operand.

**What does the resolver catch that the parser cannot?**
Anything about names: undefined names, use before definition, assigning to constants, duplicate declarations, and `return`/`break` outside their context. It also computes capture information the compiler needs.

**How does the compiler know how many values to pop on `break`?**
It tracks the exact stack depth at every instruction. Each loop records the depth at its start; `break` emits `POPN (current depth - loop depth)` and a jump. The same bookkeeping lets blocks with locals appear in the middle of expressions.

**How do you keep constant folding from changing behaviour?**
Fold only when the operands are literals and the operation succeeds; leave anything that would raise an error for run time; never reassociate floating-point arithmetic; only substitute a constant after its declaration. Then check it: the fuzzer runs every program with folding on and off.

**Why are map, filter and reduce generators?**
So the VM never re-enters its own dispatch loop. A callback becomes an ordinary frame, which keeps single-stepping, error positions and the call-depth limit correct.

**What did the fuzzer find?**
In the engines themselves, nothing in the final code, which is why the mutation check exists: it shows the fuzzer catches 10 of 11 planted bugs. During development it found a grammar problem (a line starting with `-` continued the previous statement, so generated code like `let v = a` followed by `-(v + 1)` silently became one statement) and two generator traps that made programs run forever. Profiling and tests found two performance problems and a stack-depth mismatch, listed in the README. A later review with hand-written programs found what the generator cannot produce: ranges past 2^53 (where `i + 1 == i`) made the engines disagree, and host limits (a string past JavaScript's maximum length, printing a 100,000-deep list, 100,000 nested parentheses) crashed with JavaScript exceptions. All are fixed and tested in `tests/robustness.test.ts`. The lesson is that a differential fuzzer only covers the shapes its generator knows.

**What would you do next?**
Tail calls (reuse the frame for a call in return position), a register-based or superinstruction design to cut dispatch overhead, line-number tables in a compact encoding, and a garbage-collection story if the VM were written in a language without one.

**How is the playground's step-through debugger built?**
`vm.run(1)` executes one instruction and returns. The page then reads the VM's public state: the frame stack, the value stack up to `sp`, the current function's bytecode and the source position of the next instruction. Slot names come from a table the compiler records per function.
