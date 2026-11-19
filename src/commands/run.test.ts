import { describe, expect, it, vi } from "vitest";
import type { SeqEvent } from "../events.js";
import { pollWaitMs, run } from "./run.js";

function deps(...batches: SeqEvent[][]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      ensureAgent: vi.fn(async () => {}),
      client: {
        createSession: vi.fn(async () => "s1"),
        startTurn: vi.fn(async () => {}),
        events: vi.fn(async () => batches.shift() ?? []),
      },
      cwd: "/work",
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: (text: string) => stderr.push(text) },
    },
  };
}

describe("run", () => {
  it("sends the instruction and prints progress to stderr and the result to stdout", async () => {
    const t = deps(
      [
        { seq: 1, type: "turn_started", input: "hi" },
        { seq: 2, type: "message", text: "looking" },
        { seq: 3, type: "code", code: "a\nb" },
      ],
      [],
      [
        { seq: 4, type: "code_result", ok: true, output: "x" },
        { seq: 5, type: "turn_completed", output: "answer" },
      ],
    );

    const code = await run("hi", t.deps);

    expect(code).toBe(0);
    expect(t.deps.ensureAgent).toHaveBeenCalled();
    expect(t.deps.client.createSession).toHaveBeenCalledWith("/work");
    expect(t.deps.client.startTurn).toHaveBeenCalledWith("s1", "hi");
    expect(t.deps.client.events.mock.calls).toEqual([
      ["s1", 0, pollWaitMs],
      ["s1", 3, pollWaitMs],
      ["s1", 3, pollWaitMs],
    ]);
    expect(t.stderr.join("")).toBe(
      "looking\n● run_code\n    a\n    b\n  ⎿\n    x\n",
    );
    expect(t.stdout).toEqual(["answer\n"]);
  });

  it("shortens long code results", async () => {
    const output = Array.from({ length: 25 }, (_, i) => String(i)).join("\n");
    const t = deps([
      { seq: 1, type: "code_result", ok: false, output },
      { seq: 2, type: "turn_completed", output: "" },
    ]);

    await run("hi", t.deps);

    expect(t.stderr.join("")).toMatch(
      /^ {2}✗\n {4}0\n[\s\S]* {4}19\n {4}… 5 more lines\n$/,
    );
  });

  it("returns 1 when the turn fails", async () => {
    const t = deps([{ seq: 1, type: "turn_failed", error: "boom" }]);

    expect(await run("hi", t.deps)).toBe(1);
    expect(t.stderr).toEqual(["error: boom\n"]);
    expect(t.stdout).toEqual([]);
  });
});
