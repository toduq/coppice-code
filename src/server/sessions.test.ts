import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../agent/agent.js";
import { Session, SessionManager } from "./sessions.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Session", () => {
  it("records the turn lifecycle and agent events", async () => {
    const turn = deferred<string>();
    const agent: Agent = {
      runTurn: vi.fn((_input, emit) => {
        emit({ type: "code", code: "x" });
        return turn.promise;
      }),
    };
    const session = new Session("s", agent);

    expect(session.start("hi")).toBe(true);
    expect(session.start("again")).toBe(false);
    turn.resolve("done");

    expect(await session.events.since(2, 1000)).toEqual([
      { type: "turn_completed", output: "done", seq: 3 },
    ]);
    expect(await session.events.since(0, 0)).toEqual([
      { type: "turn_started", input: "hi", seq: 1 },
      { type: "code", code: "x", seq: 2 },
      { type: "turn_completed", output: "done", seq: 3 },
    ]);
    expect(session.start("next")).toBe(true);
  });

  it("records a failed turn", async () => {
    const agent: Agent = {
      runTurn: vi.fn(async () => Promise.reject(new Error("boom"))),
    };
    const session = new Session("s", agent);

    session.start("hi");

    expect(await session.events.since(1, 1000)).toEqual([
      { type: "turn_failed", error: "boom", seq: 2 },
    ]);
  });
});

describe("SessionManager", () => {
  it("creates sessions with an agent for the cwd", () => {
    const agent: Agent = { runTurn: vi.fn() };
    const createAgent = vi.fn(() => agent);
    const manager = new SessionManager(createAgent, () => "id1");

    const session = manager.create("/work");

    expect(session.id).toBe("id1");
    expect(createAgent).toHaveBeenCalledWith("/work");
    expect(manager.get("id1")).toBe(session);
    expect(manager.get("missing")).toBeUndefined();
  });
});
