# Red Flags — Review Checklist

Warning signs of design problems, named after the red flags in *A Philosophy of Software Design* by John Ousterhout. The descriptions, detection hints and fixes are written in this skill's own words.

| # | Red flag | What it means |
|---|----------|---------------|
| 1 | Shallow Module | Using it costs about as much effort as the work it saves |
| 2 | Information Leakage | Knowledge of one design decision is spread across several modules |
| 3 | Temporal Decomposition | Code is divided by *when* steps happen, not by *what knowledge* they need |
| 4 | Overexposure | Simple uses force callers to deal with advanced options |
| 5 | Pass-Through Method | A method mostly relays its arguments to a near-identical method |
| 6 | Repetition | The same non-trivial logic shows up in several places |
| 7 | Special-General Mixture | Use-case-specific logic lives inside a general mechanism |
| 8 | Conjoined Methods | Two methods can only be understood together |
| 9 | Comment Repeats Code | The comment adds nothing beyond what the code already shows |
| 10 | Implementation Documentation Contaminates Interface | Interface docs describe internals that callers don't need |
| 11 | Vague Name | The name doesn't tell you what the thing actually is |
| 12 | Hard to Pick Name | No clear, precise name comes to mind |
| 13 | Hard to Describe | Documenting it fully takes a long, caveat-heavy explanation |
| 14 | Nonobvious Code | A quick read doesn't reveal what the code does or why |

---

## 1. Shallow Module
**Detect:** the body is about as long as the signature; thin wrapper classes; lots of tiny classes; explaining the interface takes as many words as the code.
**Fix:** merge it into its caller or callee; give the module more responsibility; hide more decisions behind it.

## 2. Information Leakage
**Detect:** changing one format, protocol or schema means editing several modules; two classes each encode or parse the same structure; modules share unwritten assumptions.
**Fix:** merge the modules that share the knowledge, or create a single module that owns it.

## 3. Temporal Decomposition
**Detect:** classes named after phases (reader / processor / writer) that each know the same data format; structure mirrors "first X, then Y".
**Fix:** organize around knowledge, e.g. one component owns the format for both reading and writing.

## 4. Overexposure
**Detect:** the common case needs several objects wired together or many options set.
**Fix:** add defaults; give the common case a single simple call; move advanced options to a separate API.

## 5. Pass-Through Method
**Detect:** `foo(a, b) { return inner.foo(a, b); }`; neighbouring layers with nearly identical signatures.
**Fix:** let callers use the lower layer directly, redistribute responsibilities, or merge the classes. For values threaded through many layers, consider a context object.

## 6. Repetition
**Detect:** copy-pasted blocks; the same special-case check repeated at many call sites.
**Fix:** extract a shared mechanism; restructure so the logic lives in one place, often a lower layer.

## 7. Special-General Mixture
**Detect:** a general utility (text model, storage layer, HTTP client) contains branches or methods for one specific feature or screen.
**Fix:** move the specific logic up into the caller, or down into a dedicated implementation behind a general interface.

## 8. Conjoined Methods
**Detect:** reading method A requires jumping to B and back; split methods pass lots of state between them.
**Fix:** recombine them, or split again along a cleaner boundary.

## 9. Comment Repeats Code
**Detect:** `// increment i`; the comment just restates the identifier (`// gets the user name` on `getUserName`).
**Fix:** delete it, or replace it with what the code can't show: units, boundaries, invariants, reasons, preconditions.

## 10. Implementation Documentation Contaminates Interface
**Detect:** a method's header comment walks through its internal algorithm or data structures.
**Fix:** move internal detail into comments inside the body; keep the header about *what* the method does and *how to use it*.

## 11. Vague Name
**Detect:** `data`, `info`, `result`, `count`, `status`, `x`; a flag called `status` without saying status of what; `tmp` that lives for more than a few lines.
**Fix:** pick a name that pins down the meaning, e.g. `cursorVisible`, `activeShardCount`.

## 12. Hard to Pick Name
**Detect:** you keep hesitating over the name; the best candidate contains "And"/"Or", or ends in "Manager"/"Helper"/"Util".
**Fix:** treat it as a design smell. The thing probably has unclear or mixed responsibilities, so rethink it.

## 13. Hard to Describe
**Detect:** the interface comment is long and full of exceptions and caveats.
**Fix:** simplify the abstraction, remove special cases, and define errors away where possible.

## 14. Nonobvious Code
**Detect:** reviewers ask "what does this do?"; hidden side effects; generic pair/tuple types; event handlers with no hint of when they fire.
**Fix:** better names, named types instead of tuples, comments for surprising behaviour, or restructuring.

---

## Additional review checks
- [ ] Could any thrown error be designed away, handled internally, or funnelled to one handler?
- [ ] Are there configuration parameters the module could work out for itself?
- [ ] Does each layer offer a different abstraction from its neighbours?
- [ ] Do getters/setters expose internal representation unnecessarily?
- [ ] Is implementation inheritance coupling parent and child classes?
- [ ] Does the change follow the codebase's existing conventions?
- [ ] Is the common-case path short and free of special-case checks?
- [ ] Do all classes and public methods have interface comments?
