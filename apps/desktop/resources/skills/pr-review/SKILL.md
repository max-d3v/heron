---
name: pr-review
description: "Review a code change (pull request, branch or diff) for bugs, questionable decisions and code smells. Summarizes issue counts, and leaves one short comment on the lines each problem concerns."
---

Review the change for three kinds of problems: **bugs**, **decisions** and **smells**. Report only what fits one of them.

## Bugs

Places where an overlooked case makes the code do the wrong thing: unhandled edge cases, wrong logic, race conditions, broken error handling, security holes, data loss, breaking changes to an API or contract.

- Name the concrete trigger: the input or state, and the wrong result it leads to.
- Confirm it by reading the real code path (callers, types, the code around the change), not just the changed lines.
- If you can't confirm it, drop it. No "possible bug" comments.

## Decisions

How the change tackles its problem: the architecture, where logic lives, the approach as a whole. Flag it when it adds more complexity than the task needs, or makes something concretely worse.

- Name the cost: what gets worse, and when. "Re-reads every config file on each poll", not "might be slow". Claims about performance, scalability or maintainability need this grounding.
- Propose a simpler or better alternative.
- If you can't do both, drop it. State it; don't phrase it as a question.

## Smells

Bad practices in code the change adds or modifies; pre-existing code is out of scope.

- Duplicated logic: the change re-implements something the repo already has (a helper, util, type or constant) or adds near-identical blocks that differ in a value or two.
- Types that bypass or blur the type system:
  - Assertions: `as X`, `as unknown as X`, non-null `!`, `any`.
  - Especially `Pick<>` types: ad-hoc slices of a domain type in signatures, like `Pick<Review, "id" | "prId">`. Take the whole type, or just the field when that's all the function reads (`scope: RepoScope`, not `Pick<Repo, "scope">`).
  - Indexed access types like `Type["x"]["y"]`: they couple the code to another type's internal shape. Use the named type (`RepoScope`, not `Repo["scope"]`), or export one if it doesn't exist.
- Functions that do more than one thing.
- try/catch blocks that wrap large sections or swallow errors.
- Deep nesting.
- Boolean flag parameters.
- Dead or commented-out code.
- Misleading names.
- Unexplained magic values.
- String interpolation that is hard to read (long or nested templates), or that builds SQL, shell commands, HTML, URLs, regexes or paths from values. When a concrete bad input breaks the latter, it's a bug.
- Clean-code and SOLID breaches that already hurt this change: a module edited for unrelated reasons, a type switch the change had to extend again, an implementation that ignores the contract it inherits. Describe the symptom, not the principle.

Simplicity wins: never ask for an abstraction the change doesn't need yet. The repo's documented conventions override this list, and skip anything a linter or formatter already enforces.

## Writing it up

**Summary**: the issue counts per category, nothing else:

> 2 bugs, 1 decision, 3 smells.

When nothing survives, return an empty summary and no comments, so nothing gets posted on the PR.

**Comments**: one per problem, on the lines it concerns.

- Point at the smallest span that shows the problem: the signature of an oversized function, the line with the cast, the `try {` that opens a large block. The span can be smaller than the whole problem.
- When the same problem appears in several places, comment on the clearest one and list the others (`path:line`) in it.
- Every problem gets a comment on the changed line that best represents it, even a decision about the overall approach. The summary never carries an issue on its own.
- Short and concise: open with the category (Bug, Decision, Smell), then what it is, with the concrete example its category requires: the trigger for a bug, the cost and alternative for a decision, what it hurts for a smell.
