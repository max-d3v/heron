import type { IterationSummary } from "@heron/rpc";

type State = IterationSummary["state"];
type Tone = "gray" | "green" | "red" | "orange" | "blue" | "purple" | "teal";

export const ITERATION_LABEL: Record<State, string> = {
  debouncing: "Waiting for more comments",
  triaging: "Triaging",
  skipped: "Nothing to change",
  awaiting_start: "Waiting for Iterate",
  held: "Waiting",
  queued: "Queued",
  preparing: "Preparing",
  running: "Running",
  committing: "Committing",
  ready: "Ready to push",
  pushing: "Pushing",
  replying: "Replying",
  pushed: "Pushed",
  no_changes: "No changes",
  discarded: "Discarded",
  uncommitted: "Uncommitted",
  failed: "Failed",
  stale: "Stale",
  cancelled: "Cancelled",
};

export const ITERATION_TONE: Record<State, Tone> = {
  debouncing: "orange",
  triaging: "blue",
  skipped: "gray",
  awaiting_start: "orange",
  held: "orange",
  queued: "orange",
  preparing: "blue",
  running: "blue",
  committing: "blue",
  ready: "purple",
  pushing: "blue",
  replying: "blue",
  pushed: "green",
  no_changes: "gray",
  discarded: "gray",
  uncommitted: "gray",
  failed: "red",
  stale: "gray",
  cancelled: "gray",
};

const IN_FLIGHT = new Set<State>(["preparing", "running", "committing", "pushing", "replying"]);
const FINISHED = new Set<State>(["skipped", "no_changes", "pushed", "discarded", "uncommitted", "failed", "stale", "cancelled"]);

export function isInFlightIteration(it: IterationSummary): boolean {
  return IN_FLIGHT.has(it.state);
}

export function isFinishedIteration(it: IterationSummary): boolean {
  return FINISHED.has(it.state);
}

/**
 * The iteration the tab shows by default: the newest one that ran the agent or is queued to
 * (batches still being triaged or waiting show in the Feedback section; skipped ones never ran).
 * Once the PR is closed, the last one pushed: closing cancels whatever was still going.
 */
export function defaultIteration(its: IterationSummary[], open: boolean): IterationSummary | null {
  if (!open) return its.find((i) => i.state === "pushed") ?? null;
  return its.find((i) => i.startedAt !== null || i.state === "queued") ?? null;
}
