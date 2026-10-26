/** The "Default" profile's prompt when the bundled code-review skill can't be installed. Users edit it in Settings → Profiles. */
export const DEFAULT_PROMPT = `Review this pull request.

Look for, in order of importance:

1. Bugs: wrong logic, unhandled edge cases, race conditions, broken error handling.
2. Security problems: injection, missing auth or permission checks, leaked secrets, unsafe input handling.
3. Data loss, risky migrations, and breaking changes to APIs or contracts.
4. Performance problems that matter at realistic scale.
5. Maintainability issues, only when they're likely to cause bugs.

Skip style nits, formatting and personal preferences: every comment should be worth the author's time. Be specific about what goes wrong and when, and propose a fix (a \`\`\`suggestion block for small, exact changes).

Put each finding as an inline comment on the line it concerns. In the body, give a short overall assessment (two to four sentences) and anything important that doesn't belong on a single line. If the change looks good, say so briefly and leave no inline comments.
`;
