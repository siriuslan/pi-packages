# Comments and Naming

Own-words guidance based on the documentation and naming chapters (Ch 12–16) of *A Philosophy of Software Design* by John Ousterhout.

## Why comments matter
- Code alone can't record **why** a choice was made, what an abstraction **promises**, the **units** of a value, or the **invariants** that must hold. "The code documents itself" only covers part of that.
- Without interface comments, callers have to read the implementation to use a module, and then the abstraction does nothing for them.
- Good comments reduce cognitive load and expose unknown unknowns.

## Core rule: write what the code can't say
A useful comment works at a **different level of detail** from the code beside it:
- **More precise than the code:** units, inclusive/exclusive bounds, what null or empty means, who owns or releases a resource, invariants.
  - e.g. `// Index of the next unread character; equals length once everything has been read.`
- **More abstract than the code:** the intent of a block, the overall approach, why the code exists at all.
  - e.g. `// Batch this request with any pending request to the same server before sending.`

If the comment would only repeat the identifier or the code in other words, find something more useful to say, or leave it out.

## Kinds of comments
1. **Interface comments** (the most important): on classes, methods and public variables.
2. **Field comments:** on data structure members.
3. **Implementation comments:** inside bodies. Explain *what* a block achieves and *why*, not a line-by-line *how*.
4. **Cross-module comments:** for decisions that span several modules. Keep them in one central place (e.g. a design-notes file) and point to it from the code.

## Interface comment template
Class:
```
/**
 * <The abstraction this class provides, in a sentence or two.>
 * <Key concepts, limits, and what one instance represents.>
 */
```
Method:
```
/**
 * <What the method does, from the caller's point of view.>
 *
 * @param x  <meaning, units, valid range, special values>
 * @return   <meaning, special values>
 * Side effects: <state changed beyond the return value>
 * Throws: <conditions the caller must handle>
 * Preconditions: <what must hold before calling>
 */
```
Interface comments should leave out internal algorithms and data structures unless a caller needs them to use the method correctly.

## Field comments
Say what the field *represents* and its constraints, not how it gets updated:
```
// Count of bytes in `buffer` holding valid data; never exceeds capacity.
// Contents past this point are undefined.
int validBytes;
```

## Implementation comments
- Put a short summary before each major block.
- For loops, say what one iteration accomplishes.
- For tricky code, explain why it's needed and which case or bug it handles.
- Don't narrate every line.

## Comment-first workflow (Ch 15)
1. Start a new class by writing its class-level comment.
2. Add signatures and interface comments for the main public methods, leaving the bodies empty.
3. Revise names, signatures and comments until the shape feels right.
4. Declare the important fields and comment them.
5. Write the bodies, adding implementation comments as you go.

Why it helps: the comments come out better, writing them exposes design problems early, and the work is more enjoyable. **A comment that is long or hard to write is a sign the abstraction needs rethinking.**

## Keeping comments accurate (Ch 16)
- Place each comment next to the code it describes. The closer it is, the more likely it gets updated.
- Put explanations of the code in the code. Commit messages describe the *change*; code comments describe the *code*.
- Write each piece of documentation once and refer to it from elsewhere.
- Review the diff before committing to check the comments still match the code.
- Higher-level comments age better than detailed ones.

## Naming (Ch 14)
Aim for names that tell the reader exactly what the thing is, with no guessing.

**Be precise**
- `getCount()`: count of what? `blinkStatus` → `cursorVisible`. Pixel-style `x`/`y` for character positions → `charIndex`/`lineIndex`.
- Name booleans as true/false statements: `cursorVisible`, `isEmpty`.
- Avoid catch-all names like `result`, `data`, `info`, `value`, `obj`.

**Be consistent**
- Use one name for one concept, every time.
- Never reuse that name for a different concept.
- Keep the meaning narrow enough that every variable with the name behaves the same way. If two blocks play different roles, name them differently (`srcBlock` vs `dstBlock`).

**Length**
- Short names are fine for a small scope with obvious meaning (`i` in a short loop). The further a name travels from its declaration, the more descriptive it should be.

**Smell:** if no simple, precise name fits, the entity's design is probably muddled.
