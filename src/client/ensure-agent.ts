export interface EnsureAgentDeps {
  health(): Promise<boolean>;
  spawnAgent(): void;
  sleep(ms: number): Promise<void>;
}

export async function ensureAgent(
  deps: EnsureAgentDeps,
  attempts = 100,
  intervalMs = 100,
): Promise<void> {
  if (await deps.health()) return;
  deps.spawnAgent();
  for (let i = 0; i < attempts; i++) {
    await deps.sleep(intervalMs);
    if (await deps.health()) return;
  }
  throw new Error("agent process did not start");
}
