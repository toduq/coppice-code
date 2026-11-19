import { createServer } from "node:http";
import OpenAI from "openai";
import { createAgent } from "../agent/agent.js";
import { createOpenAIModel, instructions } from "../agent/openai.js";
import { createCodeRunner } from "../codemode/runner.js";
import { config } from "../config.js";
import { createApp } from "../server/app.js";
import { SessionManager } from "../server/sessions.js";
import { createFileTools } from "../tools/files.js";

export function startAgent(): void {
  const openai = new OpenAI();
  const sessions = new SessionManager((cwd) =>
    createAgent(
      createOpenAIModel(openai, {
        model: config.model,
        instructions: instructions(cwd),
      }),
      createCodeRunner(createFileTools(cwd)),
    ),
  );
  createServer(createApp(sessions)).listen(config.port, "127.0.0.1", () => {
    console.error(`coppice agent listening on 127.0.0.1:${config.port}`);
  });
}
