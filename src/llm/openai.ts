import OpenAI from "openai";
import {
  LlmError,
  type CompletionRequest,
  type CompletionResponse,
  type LlmMessage,
  type LlmProvider,
  type ToolCall,
} from "./provider.ts";

export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";


export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly model: string;
  private client: OpenAI;

  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.client = options.apiKey
      ? new OpenAI({ apiKey: options.apiKey })
      : new OpenAI();
    this.model = options.model ?? DEFAULT_OPENAI_MODEL;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: 16000,
        messages: [
          { role: "system", content: request.system },
          ...request.messages.flatMap(toOpenAiMessages),
        ],
        tools: request.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: true,
          },
        })),
      });

      const choice = response.choices[0];
      if (!choice) throw new LlmError("OpenAI returned no choices", true);

      if (choice.message.refusal) {
        return {
          stopReason: "refusal",
          text: choice.message.refusal,
          toolCalls: [],
        };
      }

      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
        .filter((call) => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
       
          arguments: safeParse(call.function.arguments),
        }));

      return {
        stopReason:
          toolCalls.length > 0
            ? "tool_use"
            : choice.finish_reason === "length"
              ? "max_tokens"
              : "end_turn",
        text: choice.message.content ?? "",
        toolCalls,
        raw: choice.message,
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
            }
          : undefined,
      };
    } catch (error) {
      throw classify(error);
    }
  }
}

function toOpenAiMessages(
  message: LlmMessage,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  switch (message.role) {
    case "user":
      return [{ role: "user", content: message.content }];

    case "assistant":
      return [
        {
          role: "assistant",
          content: message.content || null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function" as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {}),
        },
      ];

    case "tool_results":
      
      return message.results.map((result) => ({
        role: "tool" as const,
        tool_call_id: result.toolCallId,
        content: result.content,
      }));
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function classify(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof OpenAI.RateLimitError) {
    return new LlmError("Rate limited by OpenAI", true, error);
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return new LlmError(
      "OpenAI rejected the API key. Check OPENAI_API_KEY.",
      false,
      error,
    );
  }
  if (error instanceof OpenAI.BadRequestError) {
    return new LlmError("Malformed request: " + error.message, false, error);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LlmError("Could not reach OpenAI", true, error);
  }
  if (error instanceof OpenAI.APIError) {
    return new LlmError(
      "OpenAI API error " + error.status + ": " + error.message,
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
