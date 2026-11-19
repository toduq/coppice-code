import { randomUUID } from "node:crypto";
import type { Agent } from "../agent/agent.js";
import { EventLog } from "./event-log.js";

export class Session {
  private running = false;

  constructor(
    readonly id: string,
    private readonly agent: Agent,
    readonly events = new EventLog(),
  ) {}

  start(input: string): boolean {
    if (this.running) return false;
    this.running = true;
    this.events.append({ type: "turn_started", input });
    this.agent
      .runTurn(input, (event) => this.events.append(event))
      .then(
        (output) => {
          this.running = false;
          this.events.append({ type: "turn_completed", output });
        },
        (error: unknown) => {
          this.running = false;
          this.events.append({
            type: "turn_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    return true;
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly createAgent: (cwd: string) => Agent,
    private readonly newId: () => string = randomUUID,
  ) {}

  create(cwd: string): Session {
    const session = new Session(this.newId(), this.createAgent(cwd));
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
}
