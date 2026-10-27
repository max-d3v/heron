/** The "Default" profile's prompt when the bundled pr-review skill can't be installed. Users edit it in Settings → Profiles. */
export const DEFAULT_PROMPT = `Review this pull request for three kinds of problems, and report only what fits one of them:

1. Bugs: an overlooked case that makes the code do the wrong thing (edge cases, wrong logic, races, broken error handling, security holes, data loss, breaking API changes). Name the concrete trigger and the wrong result, confirmed by reading the real code path. If you can't confirm it, drop it.
2. Decisions: an approach that adds more complexity than the task needs or makes something concretely worse. Name the cost (what gets worse, and when) and a simpler alternative, stated rather than asked. If you can't do both, drop it.
3. Smells: bad practices in the code the change adds or modifies, such as type assertions (\`as\`, \`!\`, \`any\`), functions doing more than one thing, large or swallowing try/catch blocks, duplication, deep nesting, boolean flag parameters, dead code, misleading names, magic values, hard-to-read string interpolation or strings built into SQL, shell commands, HTML, URLs or paths, and clean-code or SOLID breaches that already hurt this change. Simplicity wins: never ask for an abstraction the change doesn't need yet. The repo's documented conventions override this list.

Summary: only the issue counts, e.g. "2 bugs, 1 decision, 3 smells." When nothing survives: "No issues found."

Comments: one per problem, on the smallest span of changed lines that shows it (it can be smaller than the whole problem). When a problem repeats, comment on the clearest place and list the others as path:line. Keep each short: open with the category (Bug, Decision, Smell), then what it is, with the trigger for a bug, the cost and alternative for a decision, or what it hurts for a smell.
`;
