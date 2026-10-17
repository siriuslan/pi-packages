---
name: software-design-philosophy
description: Apply John Ousterhout's "A Philosophy of Software Design" to reduce complexity when designing, implementing, reviewing, or refactoring code. Use when designing modules/APIs/classes, planning a feature's structure, reviewing a PR or codebase for design quality, refactoring, writing interface comments, naming things, or deciding how to handle errors and special cases.
---

# Software Design Philosophy Skill

Inspired by the ideas in *A Philosophy of Software Design* by John Ousterhout (Yaknyam Press, 2018). This skill is an independent summary written in its own words; read the book for the full treatment.

**Goal: keep complexity low.** Here, complexity means whatever in a system's structure makes it harder to understand or change.

All `references/...` paths below are relative to this skill's directory. Read the relevant reference file before starting a Design or Review task.

If invoked as `/skill:software-design-philosophy <request>`, infer the mode (Design / Implement / Review / Modify) from the request; ask only if genuinely ambiguous.

## When to Use

- **Design mode** — new module, class, API, service, or feature structure
- **Implement mode** — writing code where structure, interfaces, errors, comments, or names matter
- **Review mode** — reviewing a PR, file, or codebase for design quality
- **Modify mode** — changing/refactoring existing code

Do NOT use for: one-line fixes, pure config changes, or throwaway scripts (unless the user asks).

## Core Mental Model

How to recognize complexity (**symptoms**):
1. **Change amplification**: one conceptual change forces edits in many places.
2. **Cognitive load**: a developer has to hold a lot in their head to make a change safely.
3. **Unknown unknowns**: it isn't clear which code to touch or what you need to know. This is the most dangerous symptom.

Where complexity comes from (**causes**):
- **Dependencies**: a piece of code can't be understood or changed on its own.
- **Obscurity**: important information isn't visible where it's needed.

Complexity builds up gradually, through many small shortcuts, so small decisions matter. Work **strategically, not tactically**: code that merely works isn't finished. Set aside a steady share of effort (roughly 10–20%) for improving the design.

## Principles (quick reference)

An own-words digest of the book's main ideas, grouped by theme:

**Investment mindset**
- Treat every small shortcut as debt; small mistakes add up.
- Judge code by its design as well as by whether it works.
- Improve the design a little with every change.

**Module and interface shape**
- Prefer **deep** modules: a small interface in front of a lot of functionality.
- Optimize the interface for the most frequent use case.
- If something has to be complicated, keep it in the implementation rather than in the interface.
- Give interfaces a little more generality than today's needs require. General interfaces tend to be deeper.
- Keep general-purpose mechanisms apart from code for specific use cases.
- Make each layer offer a different abstraction from the layers next to it.
- **Pull complexity down**: the module author absorbs difficulty so callers don't have to.

**Errors and special cases**
- Prefer semantics where the error or special case simply can't happen, over making callers handle it.

**Process**
- **Design it twice**: compare substantially different alternatives before committing.
- Build software in units of complete abstractions, not thin feature slices.

**Readability**
- Optimize for the reader, not the writer.
- Use comments for what the code itself can't say.

Details and techniques: `references/principles.md`.

## Workflow: Design Mode

1. **Clarify the information to hide.** List the design decisions/knowledge this module should own (formats, algorithms, protocols, policies). Each piece of knowledge should live in ONE module.
2. **Design it twice.** Sketch 2–3 *radically different* designs (interfaces first, not implementations). Compare on:
   - Interface simplicity for the most common use
   - Generality (could it serve other needs without changes?)
   - Information hidden vs. leaked
   - Efficiency of the implementation it permits
3. **Write the interface comments first** (comment-driven design). If a comment is long/hard to write → the abstraction is wrong. Revise.
4. **Check depth.** For each module/method: is the interface much simpler than what it does? Avoid classitis (many tiny shallow classes).
5. **Check layering.** Each layer should provide a different abstraction from the one above/below. No pass-through methods/variables.
6. **Plan errors.** For each exception: can it be defined out of existence, masked at a low level, or aggregated in one handler? Only expose what callers truly must handle.
7. **Present** using the Design Output template below.

### Design Output template
```
## Design: <name>
### Information hidden
- <decision/knowledge this module owns>
### Alternatives considered
| | Design A | Design B | Design C |
|-|-|-|-|
| Interface | ... | ... | ... |
| Pros / Cons | ... | ... | ... |
### Chosen design & why
### Interface (with interface comments)
### Error / special-case strategy
### Risks / red flags to watch
```

## Workflow: Implement Mode

- Write interface comment before implementation body.
- Keep each method doing one *complete* thing; length is fine if the method has a clean abstraction. Split only when it produces cleaner abstractions (no conjoined methods).
- Pull complexity down: choose sensible defaults, handle edge cases internally; avoid config params that push decisions to callers.
- Prefer one general mechanism over several special-case ones; eliminate `if` special cases by designing the normal case to cover them.
- Choose precise, consistent names (`references/comments-and-naming.md`).
- Make code obvious: avoid surprising control flow, generic containers (`Pair<A,B>`) for return values, and event-driven indirection without documentation.
- Before finishing, scan your own code against the red flags list.

## Workflow: Review Mode

1. Read the code; identify module boundaries and interfaces.
2. Go through the checklist in `references/red-flags.md`. For each finding, cite the file:line, the red flag, the complexity symptom it causes, and a concrete fix.
3. Assess depth of key modules (interface size vs functionality).
4. Assess comments: interface comments present? Repeating code? Implementation leaking into interface docs?
5. Output with the Review template:

```
## Design Review: <scope>
### Summary (overall complexity assessment, 2–3 sentences)
### Findings
| # | Location | Red flag | Symptom caused | Suggested fix | Severity |
### Deep vs shallow modules
### Top 3 strategic improvements
```
Severity: **High** (unknown unknowns / leakage across many modules), **Medium** (change amplification, shallow abstractions), **Low** (naming, comment quality).

## Workflow: Modify Mode

- **Stay strategic**: after the change, the design should look as if it had been designed with this change in mind from the start. Don't take the smallest possible patch if it degrades structure.
- If the existing design doesn't fit, refactor first (or propose the refactor, with cost, if it's large).
- Keep comments near the code they describe; update them in the same change. Avoid duplicating docs — reference the canonical one.
- Put design-decision explanations in code comments, not just commit messages.
- Be consistent with existing conventions, unless you're deliberately changing them everywhere.

## Guidance on Common Practices (as argued in the book)

- **Inheritance**: prefer interface inheritance; implementation inheritance creates dependencies between parent and child — prefer composition.
- **Agile**: fine, but increments should be *abstractions*, not features.
- **Unit tests**: essential — they enable refactoring.
- **TDD**: risky because it focuses on getting features working (tactical). Exception: write a failing test first when fixing a bug.
- **Design patterns**: use when they fit; don't force them.
- **Getters/setters**: shallow; avoid exposing instance variables at all where possible.
- **Performance**: think about natural efficiency while designing (cheap choices); measure before optimizing; redesign around the **critical path** — the minimal code for the common case — and keep special cases off it.

## References

- `references/principles.md` — each principle explained with techniques and examples
- `references/red-flags.md` — the 14 red flags with detection hints and fixes (review checklist)
- `references/comments-and-naming.md` — how to write comments and choose names
