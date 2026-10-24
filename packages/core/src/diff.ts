import type {
  DiffContextLine,
  PayloadComment,
  ReviewComment,
  ReviewOutput,
  ReviewPayload,
  Side,
} from "./types.ts";

export interface DiffHunk {
  header: string;
  lines: DiffContextLine[];
}

export interface DiffFile {
  /** Path in the new version (the old path for a deleted file). */
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function unquote(p: string): string {
  // git quotes paths with unusual characters: "a/some\tpath"
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function stripPrefix(p: string): string | null {
  const u = unquote(p.trim());
  if (u === "/dev/null") return null;
  return u.replace(/^[ab]\//, "");
}

/** Parse a unified diff as produced by `git diff` or GitHub's `application/vnd.github.diff`. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  // Lines left in the current hunk, from its header. Counting (rather than looking
  // at prefixes) keeps a deleted "-- comment" line from reading as a "--- " header.
  let oldLeft = 0;
  let newLeft = 0;

  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
        file!.additions++;
        newLeft--;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", oldLine: oldLine++, newLine: null, text: line.slice(1) });
        file!.deletions++;
        oldLeft--;
      } else if (line.startsWith(" ") || line === "") {
        // Some producers strip the leading space of empty context lines.
        hunk.lines.push({ kind: "ctx", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
        oldLeft--;
        newLeft--;
      }
      // "\ No newline at end of file" carries no line.
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      file = {
        path: m ? m[2]! : "",
        oldPath: m ? m[1]! : null,
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    const hm = HUNK_RE.exec(line);
    if (hm) {
      oldLine = Number(hm[1]);
      newLine = Number(hm[3]);
      oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
      newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (line.startsWith("--- ")) {
      file.oldPath = stripPrefix(line.slice(4));
      if (file.oldPath === null) file.status = "added";
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p === null) {
        file.status = "deleted";
        file.path = file.oldPath ?? file.path;
      } else {
        file.path = p;
      }
    } else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = unquote(line.slice("rename from ".length));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) file.path = unquote(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
  }
  return files;
}

function lineOn(l: DiffContextLine, side: Side): number | null {
  return side === "RIGHT" ? l.newLine : l.oldLine;
}

/** Index of the hunk containing (line, side), or -1. */
function findHunk(file: DiffFile, line: number, side: Side): number {
  return file.hunks.findIndex((h) => h.lines.some((l) => lineOn(l, side) === line));
}

function contextFor(file: DiffFile, hunkIndex: number, start: number, end: number, side: Side): DiffContextLine[] {
  const lines = file.hunks[hunkIndex]!.lines;
  const first = lines.findIndex((l) => lineOn(l, side) === start);
  const last = lines.findIndex((l) => lineOn(l, side) === end);
  if (first < 0 || last < 0) return [];
  const from = Math.max(0, first - 3);
  const to = Math.min(lines.length, last + 1);
  // Keep long ranges readable: the head of the range plus the commented line.
  if (to - from > 14) return [...lines.slice(from, from + 6), ...lines.slice(Math.max(to - 6, from + 6), to)];
  return lines.slice(from, to);
}

function formatMoved(c: ReviewComment): string {
  const loc = c.start_line && c.start_line !== c.line ? `${c.path}:${c.start_line}-${c.line}` : `${c.path}:${c.line}`;
  const text = c.body.trim().replace(/\n/g, "\n  ");
  return `- \`${loc}\` — ${text}`;
}

/**
 * Check each inline comment against the diff. Comments that GitHub would reject
 * (file or line not in the diff) move into the body as `path:line — text`.
 */
export function validateAgainstDiff(output: ReviewOutput, files: DiffFile[]): ReviewPayload {
  const byPath = new Map<string, DiffFile>();
  for (const f of files) {
    byPath.set(f.path, f);
    if (f.oldPath && !byPath.has(f.oldPath)) byPath.set(f.oldPath, f);
  }

  const comments: PayloadComment[] = [];
  const moved: ReviewComment[] = [];

  for (const raw of output.comments) {
    const c: ReviewComment = { ...raw, path: raw.path.replace(/^\.?\//, "") };
    const file = byPath.get(c.path);
    const side: Side = c.side ?? "RIGHT";
    if (!file || file.binary) {
      moved.push(c);
      continue;
    }
    const hunkIndex = findHunk(file, c.line, side);
    if (hunkIndex < 0) {
      moved.push(c);
      continue;
    }

    const out: PayloadComment = { path: file.path, line: c.line, side, body: c.body, context: [] };
    let start = c.line;
    if (c.start_line !== undefined && c.start_line < c.line) {
      const startSide: Side = c.start_side ?? side;
      // GitHub only accepts a range inside one hunk.
      if (findHunk(file, c.start_line, startSide) === hunkIndex) {
        out.start_line = c.start_line;
        out.start_side = startSide;
        if (startSide === side) start = c.start_line;
      }
    }
    out.context = contextFor(file, hunkIndex, start, c.line, side);
    comments.push(out);
  }

  let body = output.body.trim();
  if (moved.length > 0) {
    const section = ["**Comments on lines outside the diff**", "", ...moved.map(formatMoved)].join("\n");
    body = body ? `${body}\n\n---\n\n${section}` : section;
  }
  return { body, comments, movedToBody: moved };
}

/** Fold every inline comment into the body (used when GitHub rejects the inline comments). */
export function foldCommentsIntoBody(payload: ReviewPayload): ReviewPayload {
  if (payload.comments.length === 0) return payload;
  const all: ReviewComment[] = payload.comments.map(({ context: _context, ...c }) => c);
  const section = ["**Inline comments**", "", ...all.map(formatMoved)].join("\n");
  const body = payload.body ? `${payload.body}\n\n---\n\n${section}` : section;
  return { body, comments: [], movedToBody: [...payload.movedToBody, ...all] };
}

/** Lines of the diff GitHub can carry a comment on, per side. */
export function commentableLines(file: DiffFile): { RIGHT: Set<number>; LEFT: Set<number> } {
  const RIGHT = new Set<number>();
  const LEFT = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.newLine !== null) RIGHT.add(l.newLine);
      if (l.oldLine !== null) LEFT.add(l.oldLine);
    }
  }
  return { RIGHT, LEFT };
}
