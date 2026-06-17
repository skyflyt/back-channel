/**
 * Back Channel — Transcript logger.
 *
 * Records every event in a session: capability discovery, invocations,
 * approvals, denials, session end. The host and visitor both have their
 * own transcript instances (they see the same events from their respective
 * sides, but transcripts are kept locally — the Broker is content-blind).
 */

import type { BCMessage, SessionId } from "./messages.js";
import type { Scope } from "./scopes.js";

export interface TranscriptEvent {
  readonly ts: string;
  readonly sessionId: SessionId;
  readonly role: "visitor" | "host";
  readonly kind:
    | "session.start"
    | "session.end"
    | "capabilities.requested"
    | "capabilities.advertised"
    | "invoke.requested"
    | "invoke.approved"
    | "invoke.denied"
    | "invoke.rejected_by_human"
    | "invoke.completed"
    | "invoke.errored"
    | "scope.denied";
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface Transcript {
  log(event: TranscriptEvent): void;
  list(): ReadonlyArray<TranscriptEvent>;
}

/** Simple in-memory transcript. Phase 1 only. */
export class InMemoryTranscript implements Transcript {
  private events: TranscriptEvent[] = [];

  log(event: TranscriptEvent): void {
    this.events.push(event);
  }

  list(): ReadonlyArray<TranscriptEvent> {
    return this.events;
  }
}

/** Console-printing transcript that also keeps an in-memory copy. Useful for the demo. */
export class ConsoleTranscript implements Transcript {
  private inner = new InMemoryTranscript();

  constructor(private readonly label: string) {}

  log(event: TranscriptEvent): void {
    this.inner.log(event);
    const icon = ICONS[event.kind] ?? "•";
    const detail = formatDetail(event.detail);
    console.log(`[${this.label}] ${event.ts} ${icon} ${event.kind}${detail ? "  " + detail : ""}`);
  }

  list(): ReadonlyArray<TranscriptEvent> {
    return this.inner.list();
  }
}

const ICONS: Record<TranscriptEvent["kind"], string> = {
  "session.start": "🟢",
  "session.end": "🔴",
  "capabilities.requested": "❓",
  "capabilities.advertised": "📋",
  "invoke.requested": "▶️",
  "invoke.approved": "✅",
  "invoke.denied": "🚫",
  "invoke.rejected_by_human": "❌",
  "invoke.completed": "✔️",
  "invoke.errored": "💥",
  "scope.denied": "🛑",
};

function formatDetail(detail: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null) continue;
    let s: string;
    if (typeof v === "string") s = v.length > 80 ? v.slice(0, 80) + "…" : v;
    else if (typeof v === "object") s = JSON.stringify(v);
    else s = String(v);
    parts.push(`${k}=${s}`);
  }
  return parts.join(" ");
}

/** Helper: build a transcript event with the current timestamp. */
export function makeEvent(
  args: Omit<TranscriptEvent, "ts">,
): TranscriptEvent {
  return { ...args, ts: new Date().toISOString() };
}
