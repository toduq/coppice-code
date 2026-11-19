export type AgentEvent =
  | { type: "turn_started"; input: string }
  | { type: "code"; code: string }
  | { type: "code_result"; ok: boolean; output: string }
  | { type: "message"; text: string }
  | { type: "turn_completed"; output: string }
  | { type: "turn_failed"; error: string };

export type SeqEvent = AgentEvent & { seq: number };

export type Emit = (event: AgentEvent) => void;
