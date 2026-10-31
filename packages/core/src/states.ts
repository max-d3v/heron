import type { ReviewState, StepState } from "./types.ts";

// debouncing → queued → preparing → running → validating → posting → posted
//                                                         ↘ completed (dry run, or nothing to post)
// any → failed | superseded | cancelled
//
// A retry parks the review back in `queued` with `retryStep` set, so the scheduler
// resumes at the step that failed instead of redoing the agent run.

const TERMINAL: ReadonlySet<ReviewState> = new Set(["posted", "completed", "failed", "superseded", "cancelled"]);
const IN_FLIGHT: ReadonlySet<ReviewState> = new Set(["preparing", "running", "validating", "posting"]);
const PENDING: ReadonlySet<ReviewState> = new Set(["debouncing", "queued"]);

const FORWARD: Record<ReviewState, readonly ReviewState[]> = {
  debouncing: ["queued"],
  queued: ["preparing", "running", "validating", "posting"],
  preparing: ["running", "queued"],
  running: ["validating", "queued"],
  validating: ["posting", "queued"],
  posting: ["posted", "completed", "queued"],
  posted: [],
  completed: [],
  failed: [],
  superseded: [],
  cancelled: [],
};

export function isTerminal(state: ReviewState): boolean {
  return TERMINAL.has(state);
}

export function isInFlight(state: ReviewState): state is StepState {
  return IN_FLIGHT.has(state);
}

export function isPending(state: ReviewState): boolean {
  return PENDING.has(state);
}

/** Not finished yet: waiting, queued or doing work. */
export function isActive(state: ReviewState): boolean {
  return !TERMINAL.has(state);
}

export function canTransition(from: ReviewState, to: ReviewState): boolean {
  if (TERMINAL.has(from)) return false;
  if (to === "failed" || to === "superseded" || to === "cancelled") return true;
  return FORWARD[from].includes(to);
}

/** `posts`: the review goes to GitHub (not a dry run, and it has something to say). */
export function nextStep(state: StepState, posts: boolean): ReviewState {
  switch (state) {
    case "preparing":
      return "running";
    case "running":
      return "validating";
    case "validating":
      return "posting";
    case "posting":
      return posts ? "posted" : "completed";
  }
}

export const STATE_LABELS: Record<ReviewState, string> = {
  debouncing: "Waiting for more pushes",
  queued: "Queued",
  preparing: "Preparing checkout",
  running: "Reviewing",
  validating: "Validating output",
  posting: "Posting to GitHub",
  posted: "Posted",
  completed: "Completed (dry run)",
  failed: "Failed",
  superseded: "Superseded",
  cancelled: "Cancelled",
};
