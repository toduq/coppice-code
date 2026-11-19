import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type SessionHandle, type Sessions } from "./app.js";

describe("createApp", () => {
  let server: Server;
  let base: string;
  let session: SessionHandle;
  let sessions: Sessions;

  beforeEach(async () => {
    session = {
      id: "s1",
      start: vi.fn(() => true),
      events: {
        since: vi.fn(async () => [
          { type: "message" as const, text: "a", seq: 1 },
        ]),
      },
    };
    sessions = {
      create: vi.fn(() => session),
      get: vi.fn((id: string) => (id === "s1" ? session : undefined)),
    };
    server = createServer(createApp(sessions));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });

  it("reports health", async () => {
    const res = await fetch(`${base}/health`);

    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates a session", async () => {
    const res = await post("/sessions", { cwd: "/work" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "s1" });
    expect(sessions.create).toHaveBeenCalledWith("/work");
  });

  it("rejects a session without cwd", async () => {
    expect((await post("/sessions", {})).status).toBe(400);
  });

  it("starts a turn", async () => {
    const res = await post("/sessions/s1/turns", { input: "hi" });

    expect(res.status).toBe(202);
    expect(session.start).toHaveBeenCalledWith("hi");
  });

  it("rejects a turn while another is running", async () => {
    vi.mocked(session.start).mockReturnValue(false);

    expect((await post("/sessions/s1/turns", { input: "hi" })).status).toBe(
      409,
    );
  });

  it("long polls events with a capped wait", async () => {
    const res = await fetch(`${base}/sessions/s1/events?after=3&wait=99999`);

    expect(await res.json()).toEqual({
      events: [{ type: "message", text: "a", seq: 1 }],
    });
    expect(session.events.since).toHaveBeenCalledWith(3, 30000);
  });

  it("returns 404 for unknown sessions and routes", async () => {
    expect((await fetch(`${base}/sessions/x/events`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${base}/sessions`, { method: "POST", body: "{" });

    expect(res.status).toBe(400);
  });
});
