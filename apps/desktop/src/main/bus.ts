import { EventPublisher } from "@orpc/server";
import type { Activity, AgentStep, QueueStatus } from "@heron/core";
import type { AppEvent } from "@heron/rpc";

export interface StepEvent {
  id: number;
  /** One of the two is set: the run the step belongs to. */
  reviewId: number | null;
  iterationId: number | null;
  ts: number;
  step: AgentStep;
}

/** In-process bus. State is written to SQLite first; these only notify. */
export interface BusEvents {
  /** Something that affects the PR list changed. */
  prs: { at: number };
  activity: Activity;
  step: StepEvent;
  queue: QueueStatus;
  /** Navigation requests (tray, notifications, menu) and config changes, for the renderer. */
  app: AppEvent;
}

export type Bus = EventPublisher<BusEvents>;

export function createBus(): Bus {
  return new EventPublisher<BusEvents>({ maxBufferedEvents: 2000 });
}
