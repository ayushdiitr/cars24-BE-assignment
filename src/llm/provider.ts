/**
 * The entire LLM abstraction.
 *
 */

export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ToolResultMessage = {
  toolCallId: string;
  toolName: string;
  /** Serialized tool output. */
  content: string;
  isError: boolean;
};

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool_results"; results: ToolResultMessage[] };

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type CompletionRequest = {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
};

export type CompletionResponse = {
  
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "refusal";
  text: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  usage?:
    | { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
    | undefined;
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}


export class LlmError extends Error {
  readonly retryable: boolean;
  override readonly cause: unknown;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
    this.cause = cause;
  }
}
