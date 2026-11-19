import { describe, expect, it, vi } from "vitest";
import { ensureAgent } from "./ensure-agent.js";

const deps = (...health: boolean[]) => ({
  health: vi.fn(async () => health.shift() ?? false),
  spawnAgent: vi.fn(),
  sleep: vi.fn(async () => {}),
});

describe("ensureAgent", () => {
  it("does nothing when the agent is running", async () => {
    const d = deps(true);

    await ensureAgent(d);

    expect(d.spawnAgent).not.toHaveBeenCalled();
  });

  it("spawns the agent and waits until healthy", async () => {
    const d = deps(false, false, true);

    await ensureAgent(d, 5, 10);

    expect(d.spawnAgent).toHaveBeenCalledOnce();
    expect(d.sleep).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(10);
  });

  it("fails when the agent never becomes healthy", async () => {
    const d = deps();

    await expect(ensureAgent(d, 3, 10)).rejects.toThrow("did not start");
    expect(d.sleep).toHaveBeenCalledTimes(3);
  });
});
