#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AgentClient } from "./client/agent-client.js";
import { ensureAgent } from "./client/ensure-agent.js";
import { startAgent } from "./commands/agent.js";
import { run } from "./commands/run.js";
import { config } from "./config.js";

const usage = `usage:
  coppice run <instruction>
  coppice agent`;

function spawnAgent(): void {
  mkdirSync(dirname(config.logFile), { recursive: true });
  const log = openSync(config.logFile, "a");
  spawn(process.execPath, [fileURLToPath(import.meta.url), "agent"], {
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "agent":
      startAgent();
      return 0;
    case "run": {
      const instruction = rest.join(" ").trim();
      if (!instruction) break;
      const client = new AgentClient(`http://127.0.0.1:${config.port}`);
      return run(instruction, {
        ensureAgent: () =>
          ensureAgent({
            health: () => client.health(),
            spawnAgent,
            sleep,
          }).catch(() => {
            throw new Error(
              `agent process did not start; see ${config.logFile}`,
            );
          }),
        client,
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
      });
    }
  }
  process.stderr.write(`${usage}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
