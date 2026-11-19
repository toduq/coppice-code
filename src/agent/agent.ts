import type {
  ResponseCustomToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { CodeRunner } from "../codemode/runner.js";
import type { Emit } from "../events.js";

export interface Model {
  respond(input: ResponseInputItem[]): Promise<ResponseInputItem[]>;
}

export interface Agent {
  runTurn(input: string, emit: Emit): Promise<string>;
}

export function createAgent(
  model: Model,
  runCode: CodeRunner,
  maxSteps = 100,
): Agent {
  const history: ResponseInputItem[] = [];

  return {
    async runTurn(input, emit) {
      const mark = history.length;
      try {
        history.push({ role: "user", content: input });
        for (let step = 0; step < maxSteps; step++) {
          const output = await model.respond(history);
          history.push(...output);
          const calls = output.filter(
            (item): item is ResponseCustomToolCall =>
              item.type === "custom_tool_call",
          );
          const text = messageText(output);
          if (calls.length === 0) return text;
          if (text) emit({ type: "message", text });
          for (const call of calls) {
            const result =
              call.name === "run_code"
                ? await runCall(call.input, runCode, emit)
                : { ok: false, output: `unknown tool: ${call.name}` };
            history.push({
              type: "custom_tool_call_output",
              call_id: call.call_id,
              output: result.output,
            });
          }
        }
        throw new Error(`step limit of ${maxSteps} exceeded`);
      } catch (error) {
        history.length = mark;
        throw error;
      }
    },
  };
}

async function runCall(code: string, runCode: CodeRunner, emit: Emit) {
  emit({ type: "code", code });
  const result = await runCode(code);
  emit({ type: "code_result", ...result });
  return result;
}

function messageText(items: ResponseInputItem[]): string {
  return items
    .flatMap((item) =>
      item.type === "message" && Array.isArray(item.content)
        ? (item.content as { type: string; text?: string }[])
        : [],
    )
    .flatMap((part) => (part.type === "output_text" ? [part.text ?? ""] : []))
    .join("\n");
}
