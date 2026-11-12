import { randomUUID } from "node:crypto";
import {
  applyEvent,
  DomainEvent,
  EVENT_SCHEMA_VERSION,
  type DomainEventType,
  type EventPayload,
  type LiveDelta,
  type TaskState,
} from "@graphcode/protocol";
import type { Database } from "./db";

type Listener = { onEvent(e: DomainEvent, state: TaskState): void; onDelta(d: LiveDelta): void };

/**
 * Command/event engine core: validates and appends domain events, keeps in-memory
 * projections, and fans out to subscribers. Every state change goes through `emit`.
 */
export class EventStore {
  private states = new Map<string, TaskState>();
  private listeners = new Set<Listener>();

  constructor(private readonly db: Database) {
    for (const e of db.allEvents()) {
      this.states.set(e.taskId, applyEvent(this.states.get(e.taskId) ?? null, e));
    }
  }

  emit<T extends DomainEventType>(taskId: string, type: T, payload: EventPayload<T>): TaskState {
    const prev = this.states.get(taskId) ?? null;
    const event = DomainEvent.parse({
      id: randomUUID(),
      taskId,
      seq: (prev?.lastSeq ?? -1) + 1,
      at: new Date().toISOString(),
      v: EVENT_SCHEMA_VERSION,
      type,
      payload,
    });
    const next = applyEvent(prev, event);
    this.db.appendEvent(event);
    this.states.set(taskId, next);
    for (const l of this.listeners) l.onEvent(event, next);
    return next;
  }

  delta(d: LiveDelta) {
    for (const l of this.listeners) l.onDelta(d);
  }

  get(taskId: string): TaskState | null {
    return this.states.get(taskId) ?? null;
  }

  all(): TaskState[] {
    return [...this.states.values()];
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
