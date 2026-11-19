import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import type { SeqEvent } from "../events.js";

export interface SessionHandle {
  id: string;
  start(input: string): boolean;
  events: { since(after: number, waitMs: number): Promise<SeqEvent[]> };
}

export interface Sessions {
  create(cwd: string): SessionHandle;
  get(id: string): SessionHandle | undefined;
}

export const maxWaitMs = 30000;

export function createApp(sessions: Sessions): RequestListener {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/health")
        return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/sessions") {
        const { cwd } = await readJson(req);
        if (typeof cwd !== "string")
          return send(res, 400, { error: "cwd is required" });
        return send(res, 201, { id: sessions.create(cwd).id });
      }

      if (parts[0] === "sessions" && parts[1] && parts.length === 3) {
        const session = sessions.get(parts[1]);
        if (!session) return send(res, 404, { error: "session not found" });

        if (req.method === "POST" && parts[2] === "turns") {
          const { input } = await readJson(req);
          if (typeof input !== "string")
            return send(res, 400, { error: "input is required" });
          if (!session.start(input))
            return send(res, 409, { error: "a turn is already running" });
          return send(res, 202, {});
        }

        if (req.method === "GET" && parts[2] === "events") {
          const after = Number(url.searchParams.get("after") ?? 0);
          const wait = Math.min(
            Number(url.searchParams.get("wait") ?? 0),
            maxWaitMs,
          );
          return send(res, 200, {
            events: await session.events.since(after, wait),
          });
        }
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
