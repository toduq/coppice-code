import { describe, expect, it, vi } from "vitest";
import { AgentClient } from "./agent-client.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("AgentClient", () => {
  it("reports health", async () => {
    const fetchFn = vi.fn(async () => json({ ok: true }));

    expect(await new AgentClient("http://a", fetchFn).health()).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("http://a/health");
  });

  it("reports unhealthy when the agent is unreachable", async () => {
    const fetchFn = vi.fn(async () =>
      Promise.reject(new Error("ECONNREFUSED")),
    );

    expect(await new AgentClient("http://a", fetchFn).health()).toBe(false);
  });

  it("creates a session", async () => {
    const fetchFn = vi.fn(async () => json({ id: "s1" }, 201));

    expect(await new AgentClient("http://a", fetchFn).createSession("/w")).toBe(
      "s1",
    );
    expect(fetchFn).toHaveBeenCalledWith("http://a/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/w" }),
    });
  });

  it("starts a turn", async () => {
    const fetchFn = vi.fn(async () => json({}, 202));

    await new AgentClient("http://a", fetchFn).startTurn("s1", "hi");

    expect(fetchFn).toHaveBeenCalledWith(
      "http://a/sessions/s1/turns",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("polls events", async () => {
    const events = [{ type: "message", text: "a", seq: 1 }];
    const fetchFn = vi.fn(async () => json({ events }));

    expect(
      await new AgentClient("http://a", fetchFn).events("s1", 2, 500),
    ).toEqual(events);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://a/sessions/s1/events?after=2&wait=500",
      expect.anything(),
    );
  });

  it("throws the agent error", async () => {
    const fetchFn = vi.fn(async () =>
      json({ error: "a turn is already running" }, 409),
    );

    await expect(
      new AgentClient("http://a", fetchFn).startTurn("s1", "hi"),
    ).rejects.toThrow("a turn is already running");
  });
});
