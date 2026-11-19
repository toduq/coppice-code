import type { SeqEvent } from "../events.js";

export interface RunDeps {
  ensureAgent(): Promise<void>;
  client: {
    createSession(cwd: string): Promise<string>;
    startTurn(sessionId: string, input: string): Promise<void>;
    events(
      sessionId: string,
      after: number,
      waitMs: number,
    ): Promise<SeqEvent[]>;
  };
  cwd: string;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

export const pollWaitMs = 25000;
const maxResultLines = 20;

export async function run(instruction: string, deps: RunDeps): Promise<number> {
  await deps.ensureAgent();
  const sessionId = await deps.client.createSession(deps.cwd);
  await deps.client.startTurn(sessionId, instruction);
  let after = 0;
  for (;;) {
    for (const event of await deps.client.events(
      sessionId,
      after,
      pollWaitMs,
    )) {
      after = event.seq;
      switch (event.type) {
        case "code":
          deps.stderr.write(`● run_code\n${indent(event.code)}\n`);
          break;
        case "code_result":
          deps.stderr.write(
            `${event.ok ? "  ⎿" : "  ✗"}\n${indent(head(event.output))}\n`,
          );
          break;
        case "message":
          deps.stderr.write(`${event.text}\n`);
          break;
        case "turn_completed":
          deps.stdout.write(`${event.output}\n`);
          return 0;
        case "turn_failed":
          deps.stderr.write(`error: ${event.error}\n`);
          return 1;
      }
    }
  }
}

function head(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= maxResultLines) return text;
  return [
    ...lines.slice(0, maxResultLines),
    `… ${lines.length - maxResultLines} more lines`,
  ].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
