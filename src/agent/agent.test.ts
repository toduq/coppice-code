import type { ResponseInputItem } from "openai/resources/responses/responses";
import { describe, expect, it, vi } from "vitest";
import { createAgent, type Model } from "./agent.js";

const message = (text: string): ResponseInputItem => ({
  type: "message",
  id: "m",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

const call = (input: string, name = "run_code"): ResponseInputItem => ({
  type: "custom_tool_call",
  call_id: "c1",
  name,
  input,
});

function fakeModel(
  ...responses: ResponseInputItem[][]
): Model & { inputs: ResponseInputItem[][] } {
  const inputs: ResponseInputItem[][] = [];
  return {
    inputs,
    respond: vi.fn(async (input: ResponseInputItem[]) => {
      inputs.push(structuredClone(input));
      const next = responses.shift();
      if (!next) throw new Error("no response");
      return next;
    }),
  };
}

describe("createAgent", () => {
  it("returns the final message when no code is run", async () => {
    const model = fakeModel([message("hi")]);
    const agent = createAgent(model, vi.fn());

    expect(await agent.runTurn("hello", vi.fn())).toBe("hi");
    expect(model.inputs[0]).toEqual([{ role: "user", content: "hello" }]);
  });

  it("runs code, emits events and sends the output back", async () => {
    const model = fakeModel(
      [message("looking"), call("return 1")],
      [message("done")],
    );
    const runCode = vi.fn(async () => ({ ok: true, output: "1" }));
    const emit = vi.fn();
    const agent = createAgent(model, runCode);

    expect(await agent.runTurn("go", emit)).toBe("done");
    expect(runCode).toHaveBeenCalledWith("return 1");
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "message", text: "looking" },
      { type: "code", code: "return 1" },
      { type: "code_result", ok: true, output: "1" },
    ]);
    expect(model.inputs[1]?.at(-1)).toEqual({
      type: "custom_tool_call_output",
      call_id: "c1",
      output: "1",
    });
  });

  it("answers unknown tools with an error", async () => {
    const model = fakeModel([call("x", "other")], [message("ok")]);
    const runCode = vi.fn();
    const agent = createAgent(model, runCode);

    await agent.runTurn("go", vi.fn());

    expect(runCode).not.toHaveBeenCalled();
    expect(model.inputs[1]?.at(-1)).toMatchObject({
      output: "unknown tool: other",
    });
  });

  it("keeps history across turns", async () => {
    const model = fakeModel([message("a")], [message("b")]);
    const agent = createAgent(model, vi.fn());

    await agent.runTurn("1", vi.fn());
    await agent.runTurn("2", vi.fn());

    expect(model.inputs[1]).toEqual([
      { role: "user", content: "1" },
      message("a"),
      { role: "user", content: "2" },
    ]);
  });

  it("drops a failed turn from history", async () => {
    const model = fakeModel([message("ok")]);
    vi.mocked(model.respond).mockRejectedValueOnce(new Error("api down"));
    const agent = createAgent(model, vi.fn());

    await expect(agent.runTurn("1", vi.fn())).rejects.toThrow("api down");
    await agent.runTurn("2", vi.fn());

    expect(model.inputs[0]).toEqual([{ role: "user", content: "2" }]);
  });

  it("fails after the step limit", async () => {
    const model = fakeModel([call("1")], [call("2")]);
    const agent = createAgent(
      model,
      vi.fn(async () => ({ ok: true, output: "" })),
      2,
    );

    await expect(agent.runTurn("go", vi.fn())).rejects.toThrow(
      "step limit of 2 exceeded",
    );
  });
});
