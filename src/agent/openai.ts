import type OpenAI from "openai";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { runCodeDescription } from "../codemode/description.js";
import type { Model } from "./agent.js";

export interface OpenAIModelOptions {
  model: string;
  instructions: string;
}

export function createOpenAIModel(
  client: Pick<OpenAI, "responses">,
  options: OpenAIModelOptions,
): Model {
  return {
    async respond(input) {
      const response = await client.responses.create({
        model: options.model,
        instructions: options.instructions,
        input,
        tools: [
          { type: "custom", name: "run_code", description: runCodeDescription },
        ],
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      return response.output as ResponseInputItem[];
    },
  };
}

export function instructions(cwd: string): string {
  return `You are coppice, a coding agent.
Working directory: ${cwd}
Use run_code to inspect the project before answering questions about it. Finish with a concise answer to the user.`;
}
