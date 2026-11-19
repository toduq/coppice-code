import type { AgentEvent, SeqEvent } from "../events.js";

export class EventLog {
  private readonly events: SeqEvent[] = [];
  private readonly waiters = new Set<() => void>();

  append(event: AgentEvent): void {
    this.events.push({ ...event, seq: this.events.length + 1 });
    for (const wake of this.waiters) wake();
  }

  async since(after: number, waitMs: number): Promise<SeqEvent[]> {
    if (this.events.length <= after && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, waitMs);
        this.waiters.add(wake);
      });
    }
    return this.events.slice(after);
  }
}
