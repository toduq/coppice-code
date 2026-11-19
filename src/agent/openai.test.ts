import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { runCodeDescription } from "../codemode/description.js";
import { createOpenAIModel } from "./openai.js";

describe("createOpenAIModel", () => {
  it("calls the Responses API with the run_code custom tool", async () => {
    const output = [{ type: "message" }];
    const create = vi.fn(async () => ({ output }));
    const client = { responses: { create } } as unknown as Pick<
      OpenAI,
      "responses"
    >;
    const model = createOpenAIModel(client, {
      model: "m",
      instructions: "be nice",
    });

    const result = await model.respond([{ role: "user", content: "hi" }]);

    expect(result).toBe(output);
    expect(create).toHaveBeenCalledWith({
      model: "m",
      instructions: "be nice",
      input: [{ role: "user", content: "hi" }],
      tools: [
        { type: "custom", name: "run_code", description: runCodeDescription },
      ],
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });
});
