import { homedir } from "node:os";
import { join } from "node:path";

export const config = {
  port: Number(process.env.COPPICE_PORT ?? 4517),
  model: process.env.COPPICE_MODEL ?? "gpt-5.5",
  logFile: join(homedir(), ".coppice", "agent.log"),
};
