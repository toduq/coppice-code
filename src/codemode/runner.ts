import vm from "node:vm";
import type { FileTools } from "../tools/files.js";
import { maxOutputChars } from "./description.js";

export interface CodeResult {
  ok: boolean;
  output: string;
}

export type CodeRunner = (code: string) => Promise<CodeResult>;

export function createCodeRunner(
  tools: FileTools,
  timeoutMs = 30000,
): CodeRunner {
  return async (code) => {
    const outputs: string[] = [];
    const out = (value: unknown) => {
      outputs.push(format(value));
    };
    const context = vm.createContext({
      tools,
      out,
      console: {
        log: (...values: unknown[]) => out(values.map(format).join(" ")),
      },
    });
    let ok = true;
    try {
      const promise = vm.runInContext(
        `(async () => {\n${stripFence(code)}\n})()`,
        context,
        {
          filename: "run_code.js",
          timeout: timeoutMs,
        },
      );
      const result = await withTimeout(promise, timeoutMs);
      if (result !== undefined) out(result);
    } catch (error) {
      ok = false;
      outputs.push(formatError(error));
    }
    return {
      ok,
      output: truncate(
        outputs.length === 0 ? "(no output)" : outputs.join("\n"),
      ),
    };
  };
}

function stripFence(code: string): string {
  const match = code.trim().match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  return match?.[1] ?? code;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2) ?? String(value);
}

function formatError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const name = "name" in error ? String(error.name) : "Error";
    return `${name}: ${String(error.message)}`;
  }
  return `Error: ${String(error)}`;
}

function truncate(text: string): string {
  if (text.length <= maxOutputChars) return text;
  const omitted = text.length - maxOutputChars;
  return `${text.slice(0, maxOutputChars)}\n[truncated ${omitted} characters; narrow the output]`;
}
