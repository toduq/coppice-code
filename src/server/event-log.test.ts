import { describe, expect, it, vi } from "vitest";
import { EventLog } from "./event-log.js";

describe("EventLog", () => {
  it("returns events after a sequence number", async () => {
    const log = new EventLog();
    log.append({ type: "message", text: "a" });
    log.append({ type: "message", text: "b" });

    expect(await log.since(1, 0)).toEqual([
      { type: "message", text: "b", seq: 2 },
    ]);
  });

  it("waits for the next event", async () => {
    const log = new EventLog();
    const pending = log.since(0, 10000);
    log.append({ type: "message", text: "a" });

    expect(await pending).toEqual([{ type: "message", text: "a", seq: 1 }]);
  });

  it("returns nothing after the wait expires", async () => {
    vi.useFakeTimers();
    const log = new EventLog();
    const pending = log.since(0, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual([]);
    vi.useRealTimers();
  });
});
