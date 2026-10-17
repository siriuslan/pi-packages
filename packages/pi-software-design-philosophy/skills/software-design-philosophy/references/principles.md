# Design Principles — Detailed

An own-words summary of the main ideas in *A Philosophy of Software Design* by John Ousterhout (2018), arranged by theme. Chapter pointers `[Ch N]` are for readers who want the original discussion.

---

## A. Understanding complexity [Ch 2]

- **Definition used here:** complexity is anything in a system's structure that makes it harder to understand or modify. It's about how the code feels to work with, not its size.
- **Weight by attention:** complexity in code that people rarely open costs less than complexity in code they touch every week. Focus clean-up where developers spend their time.
- **Readers judge it, not writers:** the author is the worst judge of whether code is complex. If reviewers or teammates struggle, treat that as the verdict.
- **It accumulates:** no single shortcut ruins a codebase. Hundreds of reasonable-looking ones do. Hold a firm line on small things.

## B. Investment mindset [Ch 3]

- **Tactical style:** optimize for finishing the current task, patching around obstacles. It feels fast, but every task leaves a little more mess behind.
- **Strategic style:** aim for a good design that also works. Assume you'll be living in this code for years.
- **How much to invest:** a modest, steady share of time (on the order of 10–20%) for design work. Two forms:
  - *Proactive*: explore alternatives, write documentation, anticipate likely changes.
  - *Reactive*: when you discover a design flaw, fix it rather than working around it.
- The return arrives within months, and that holds for startups too: a messy codebase slows the team down and makes hiring harder.

## C. Deep modules [Ch 4]

- A **module** is anything with an interface and an implementation: a function, class, package or service.
- An interface has a **formal** part (signatures, types) and an **informal** part (behaviour, side effects, ordering rules, assumptions). The informal part is often larger and more important.
- A good **abstraction** leaves out details that don't matter and keeps the ones that do. Two failure modes:
  - It shows too much → callers carry needless detail.
  - It hides something that matters → a misleading abstraction.
- **Depth** = functionality provided ÷ interface cost. Aim high.
  - *Deep:* a file API with a handful of calls that hides disk layout, caching, and scheduling; a garbage collector with essentially no interface.
  - *Shallow:* a method whose body is a one-line call with the same information as its signature.
- **Classitis:** splitting code into many tiny classes by habit. Each one adds interface cost and delivers little. Example of the result: needing to compose several stream wrapper objects just to read a file efficiently, when buffering could simply be the default.

## D. Interfaces for the common case [Ch 4, 6]

- Make the most frequent use require the least knowledge and the fewest steps.
- Give options sensible defaults. Rarely used features shouldn't force themselves on everyday callers.

## E. Simple interface beats simple implementation [Ch 8]

- A module typically has far more callers than maintainers, so extra effort by its author saves effort many times over.

## F. Somewhat general-purpose interfaces [Ch 6]

- Implement what you need today, but shape the **interface** so it isn't tied to one particular caller.
- Illustration (text editor): rather than offering separate operations for each UI action (delete-before-cursor, delete-after-cursor, delete-selection), offer general text operations such as "insert at position" and "delete range". The UI combines them.
- Self-check questions:
  - What's the smallest interface that covers everything I currently need?
  - How many different situations will use this method? If only one, it's probably too specialized.
  - Is it easy to use for today's needs? If callers need a lot of glue code, it has become too general or too low-level.

## G. Keep special-purpose code out of general code [Ch 6, 9]

- Move use-case-specific logic **upward**, into the application or UI, or **downward** into specific implementations behind a general interface.
- A general layer should not know about the particular features built on top of it.

## H. Distinct abstractions per layer [Ch 7]

- If two adjacent layers expose nearly the same abstraction, one of them is probably not earning its place.
- **Forwarding methods** that just relay calls with the same signature add interface cost without adding value. Options: let callers use the lower layer directly, move responsibilities so each layer does real work, or merge the layers.
- Having several methods with the same signature is fine when each does genuinely different work (e.g. a dispatcher choosing among implementations).
- **Wrappers/decorators** are often shallow. Before writing one, ask whether the feature belongs in the wrapped class, at the single call site, or in an existing wrapper.
- **Variables threaded through many layers** that don't use them: consider a shared context object reachable from the places that need it. Prefer immutable contents and watch for concurrency issues.

## I. Pull complexity down [Ch 8]

- When some difficulty is unavoidable, handle it inside the module instead of exporting it to every caller.
- Be wary of **configuration knobs**. Ask: "Is the caller really better placed than the module to choose this value?" Often the module can compute or adapt it. If a knob is needed, give it a good default.
- Limit: only absorb complexity that fits the module's purpose and that actually simplifies the rest of the system.

## J. Combine or split? [Ch 9]

Lean towards **combining** when pieces:
- share information or assumptions
- are always used together
- overlap in concept
- can't be understood one without the other
- would remove duplication or shrink an interface once merged

Lean towards **splitting** when general-purpose and special-purpose concerns are mixed.

**Method size:** length alone isn't a problem. A long method with a simple signature that reads top to bottom can be fine. Split when the pieces form cleaner abstractions on their own. If readers must bounce between two methods to understand either, they shouldn't have been split that way.

Two good ways to split:
- Extract a self-contained subtask into a helper. Good when the helper is general and the parent gets simpler.
- Divide into two independent methods exposed to callers. Good only if each one is simpler and useful on its own.

## K. Errors and special cases [Ch 10]

Every exception adds code paths that rarely run and are rarely tested. Raising them is cheap; handling them everywhere is expensive. Ways to reduce the number of places that must handle them:

1. **Redefine the operation so the error disappears.**
   - "Remove variable X" can be defined as "ensure X does not exist", which succeeds even if X was never there.
   - Deleting a file that's still open can remove its name immediately and reclaim the storage once the last user closes it, instead of refusing.
   - Taking a substring with out-of-range indices can return the overlapping part instead of throwing.
2. **Mask it low down.** Handle the problem inside the module so higher layers never see it. Transport protocols retransmit lost packets; a network file client can retry until the server comes back.
3. **Aggregate handling.** Route many similar errors to one handler, e.g. one top-level handler that turns any missing-parameter error into an error response, or one recovery path for many kinds of corruption.
4. **Crash on the hopeless.** For errors that are rare and practically unrecoverable (out of memory, broken internal invariants), log diagnostics and stop instead of threading handling code everywhere.

The same thinking applies to **special cases**: design the normal path so the edge case falls out naturally. For example, treat "no selection" as an empty selection that behaves like any other.

Don't overdo it: if callers genuinely need to know about a condition, expose it.

## L. Design it twice [Ch 11]

- First ideas are rarely the best. Sketch at least two substantially different designs, even if one seems weak; comparing them sharpens your thinking.
- Compare **interfaces** first, then implementations.
- Criteria: which gives callers the simpler interface? Which is more general? Which allows a more efficient implementation?
- The time cost is small compared with living with a weaker design. Experienced and talented engineers especially tend to skip this step.

## M. Readability [Ch 18]

**Helps:** precise names, consistency, considered white space, comments that explain intent.

**Hurts:**
- event-driven flow where it's unclear when a handler runs (document it)
- generic tuple/pair return types (define a small named type instead)
- declared and runtime types that differ in surprising ways
- code that breaks the reader's expectations, such as an entry point that returns while background work keeps running (document it)

If a reviewer finds something unclear, it *is* unclear. Change the code rather than defending it.

## N. Build abstractions, not slices [Ch 19]

- Iterative development is fine, but once you know an abstraction is needed, build it properly as a whole rather than growing it piece by piece across feature tickets.

## O. Consistency [Ch 17]

- Covers names, style, interfaces with multiple implementations, recurring patterns and invariants.
- Keep it up by writing conventions down, checking them with tools and review, and following local habits when you're in someone else's code.
- Only change a convention if the new one is clearly better **and** you migrate every existing use.

## P. On popular practices [Ch 19]

- **Inheritance:** sharing an interface is useful; sharing implementation couples parent and child tightly. Prefer composition.
- **Unit tests:** very valuable, mainly because they make refactoring safe.
- **Test-driven development:** risks steering attention toward passing the next test rather than toward good abstractions. Writing a failing test first is still a good habit for bug fixes.
- **Design patterns:** useful when they genuinely fit; harmful when forced.
- **Getters/setters:** usually shallow and leak representation. Avoid exposing internal fields where possible.

## Q. Performance [Ch 20]

- Know roughly what's expensive (network round trips, storage I/O, dynamic allocation, cache misses). When two designs are equally clean, pick the naturally faster one.
- Measure before optimizing, and measure again afterwards.
- For hot spots, identify the **critical path**: the minimum work the common case needs. Picture the ideal implementation, then restructure so the common case runs that path, with special cases checked once and handled elsewhere.
- Clean design and good performance usually go together, because simpler code tends to do less work.
