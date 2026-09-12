import Anthropic from "@anthropic-ai/sdk";
import {
  LlmError,
  type CompletionRequest,
  type CompletionResponse,
  type LlmMessage,
  type LlmProvider,
  type ToolCall,
} from "./provider.ts";

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

/**
 * Anthropic adapter.
 *
 * Everything vendor-specific is contained here: message shapes, tool-block
 * handling, caching directives and error classification. The orchestrator
 * above sees only the LlmProvider interface.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.client = options.apiKey
      ? new Anthropic({ apiKey: options.apiKey })
      : new Anthropic();
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
       
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        // Cached prefix. Render order is tools -> system -> messages, so the
        // stable half (tool definitions + system prompt) caches and only the
        // varying conversation is re-read each turn.
        system: [
          {
            type: "text",
            text: request.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      
          strict: false,
        })),
        messages: request.messages.map(toAnthropicMessage),
      });

      if (response.stop_reason === "refusal") {
        return {
          stopReason: "refusal",
          text:
            "The model declined to answer this request" +
            (response.stop_details?.explanation
              ? ": " + response.stop_details.explanation
              : "."),
          toolCalls: [],
        };
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      const toolCalls: ToolCall[] = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          name: b.name,
          arguments: b.input,
        }));

      return {
        stopReason:
          response.stop_reason === "tool_use"
            ? "tool_use"
            : response.stop_reason === "max_tokens"
              ? "max_tokens"
              : "end_turn",
        text,
        toolCalls,
        raw: response.content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (error) {
      throw classify(error);
    }
  }
}

function toAnthropicMessage(message: LlmMessage): Anthropic.MessageParam {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };

    case "assistant":
    
      return {
        role: "assistant",
        content:
          (message.raw as Anthropic.ContentBlockParam[] | undefined) ??
          message.content,
      };

    case "tool_results":
   
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.toolCallId,
          content: result.content,
          is_error: result.isError,
        })),
      };
  }
}

/** Maps SDK errors onto the transport-level retryable/fatal distinction. */
function classify(error: unknown): LlmError {
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError("Rate limited by Anthropic", true, error);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError(
      "Anthropic rejected the API key. Check ANTHROPIC_API_KEY.",
      false,
      error,
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new LlmError("Malformed request: " + error.message, false, error);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError("Could not reach Anthropic", true, error);
  }
  if (error instanceof Anthropic.APIError) {
    // 5xx is worth one retry; other statuses are not.
    return new LlmError(
      "Anthropic API error " + error.status + ": " + error.message,
      (error.status ?? 500) >= 500,
      error,
    );
  }
  return new LlmError(
    error instanceof Error ? error.message : String(error),
    false,
    error,
  );
}
