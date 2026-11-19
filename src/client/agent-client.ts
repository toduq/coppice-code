import type { SeqEvent } from "../events.js";

export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async createSession(cwd: string): Promise<string> {
    const { id } = await this.request<{ id: string }>("POST", "/sessions", {
      cwd,
    });
    return id;
  }

  async startTurn(sessionId: string, input: string): Promise<void> {
    await this.request("POST", `/sessions/${sessionId}/turns`, { input });
  }

  async events(
    sessionId: string,
    after: number,
    waitMs: number,
  ): Promise<SeqEvent[]> {
    const { events } = await this.request<{ events: SeqEvent[] }>(
      "GET",
      `/sessions/${sessionId}/events?after=${after}&wait=${waitMs}`,
    );
    return events;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok)
      throw new Error(
        `agent ${method} ${path} failed: ${json.error ?? res.status}`,
      );
    return json as T;
  }
}
