import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Issue } from "../reconcile/types.ts";
import { listTools, runTool } from "../tools/registry.ts";
import type { ToolCallRecord } from "../tools/types.ts";
import { addUsd, costForUsage, type AttemptCost } from "../llm/pricing.ts";
import { persistQueryAttempt } from "../repo/queryLogs.ts";
import {
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type ToolSpec,
} from "../llm/provider.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

export const MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS ?? 8);
const RETRY_DELAY_MS = 500;

export type AgentAnswer = {
  queryId: string;
  answer: string;
  toolCalls: ToolCallRecord[];
  issues: Issue[];
  iterations: number;
  degraded: boolean;
  usage: QueryUsage;
};

export type QueryUsage = {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  inputCostUsd: string | null;
  outputCostUsd: string | null;
  cacheReadCostUsd: string | null;
  totalCostUsd: string | null;
};

const emptyUsage = (): QueryUsage => ({
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  inputCostUsd: "0.000000",
  outputCostUsd: "0.000000",
  cacheReadCostUsd: "0.000000",
  totalCostUsd: "0.000000",
});

let cachedSpecs: ToolSpec[] | null = null;

function toolSpecs(): ToolSpec[] {
  if (cachedSpecs) return cachedSpecs;

  cachedSpecs = listTools().map((tool) => {
    const schema = z.toJSONSchema(tool.schema, { io: "input" }) as Record<
      string,
      unknown
    >;
    schema.additionalProperties = false;

    return {
      name: tool.name,
      description: tool.description,
      inputSchema: schema,
    };
  });

  return cachedSpecs;
}

/**
 * The agent loop.
 *
 * The model chooses tools; this function executes them, feeds the results
 * back, and stops.
 */
export async function answerQuery(
  query: string,
  provider: LlmProvider,
  options: { queryId?: string } = {},
): Promise<AgentAnswer> {
  const queryId = options.queryId ?? randomUUID();
  const messages: LlmMessage[] = [{ role: "user", content: query }];
  const toolCalls: ToolCallRecord[] = [];
  const issues: Issue[] = [];
  const usage = emptyUsage();

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    let response: Awaited<ReturnType<typeof complete>>;
    try {
      response = await complete(provider, {
        system: SYSTEM_PROMPT,
        messages,
        tools: toolSpecs(),
      }, {
        queryId,
        iteration: iterations,
        attemptOffset: usage.attempts,
        onAttempt: (attempt) => addAttemptUsage(usage, attempt),
      });
    } catch (error) {
      // Transport failed twice. Degrade to an honest non-answer rather than
      // a 500: the ops user learns the lookup failed and can retry.
      return {
        queryId,
        answer:
          "I couldn't complete this lookup — the language model was " +
          "unreachable. " +
          (error instanceof LlmError ? error.message : String(error)) +
          (toolCalls.length > 0
            ? " Data already retrieved is included in the tool trace."
            : ""),
        toolCalls,
        issues,
        iterations,
        degraded: true,
        usage,
      };
    }

    if (response.response.stopReason === "refusal") {
      return {
        queryId,
        answer: response.response.text,
        toolCalls,
        issues,
        iterations,
        degraded: true,
        usage,
      };
    }

    if (
      response.response.stopReason !== "tool_use" ||
      response.response.toolCalls.length === 0
    ) {
      return {
        queryId,
        answer: response.response.text,
        toolCalls,
        issues,
        iterations,
        degraded: false,
        usage,
      };
    }

    // Independent lookups run concurrently — the model is encouraged to batch
    // them, so serialising here would waste most of that.
    const records = await Promise.all(
      response.response.toolCalls.map((call) =>
        runTool(call.name, call.arguments, { queryId }),
      ),
    );

    for (const record of records) {
      toolCalls.push(record);
      collectIssues(record, issues);
    }

    messages.push(
      {
        role: "assistant",
        content: response.response.text,
        toolCalls: response.response.toolCalls,
        ...(response.response.raw !== undefined
          ? { raw: response.response.raw }
          : {}),
      },
      {
        role: "tool_results",
        results: records.map((record, index) => ({
          toolCallId: response.response.toolCalls[index]!.id,
          toolName: record.toolName,
          content: JSON.stringify(record.result),
          isError: !record.result.ok,
        })),
      },
    );
  }

 
  return {
    queryId,
    answer:
      "I couldn't finish this within " + MAX_ITERATIONS + " steps. " +
      "The data gathered so far is in the tool trace — try a narrower question.",
    toolCalls,
    issues,
    iterations,
    degraded: true,
    usage,
  };
}

/** One retry with a short backoff, but only for failures worth retrying. */
async function complete(
  provider: LlmProvider,
  request: Parameters<LlmProvider["complete"]>[0],
  context: {
    queryId: string;
    iteration: number;
    attemptOffset: number;
    onAttempt: (attempt: {
      usage: Awaited<ReturnType<LlmProvider["complete"]>>["usage"];
      cost: AttemptCost;
    }) => void;
  },
): Promise<{
  response: Awaited<ReturnType<LlmProvider["complete"]>>;
  attempts: {
    usage: Awaited<ReturnType<LlmProvider["complete"]>>["usage"];
    cost: AttemptCost;
  }[];
}> {
  const attempts: {
    usage: Awaited<ReturnType<LlmProvider["complete"]>>["usage"];
    cost: AttemptCost;
  }[] = [];

  const invoke = async () => {
    const attempt = context.attemptOffset + attempts.length + 1;
    const startedAt = performance.now();
    try {
      const response = await provider.complete(request);
      const cost = costForUsage(provider.name, provider.model, response.usage);
      attempts.push({ usage: response.usage, cost });
      context.onAttempt({ usage: response.usage, cost });
      await persistQueryAttempt({
        queryId: context.queryId,
        provider: provider.name,
        model: provider.model,
        attempt,
        iteration: context.iteration,
        status: "succeeded",
        stopReason: response.stopReason,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        cacheReadTokens: response.usage?.cacheReadTokens,
        ...cost,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return response;
    } catch (error) {
      const failedAttempt = { usage: undefined, cost: costForUsage(provider.name, provider.model, undefined) };
      attempts.push(failedAttempt);
      context.onAttempt(failedAttempt);
      await persistQueryAttempt({
        queryId: context.queryId,
        provider: provider.name,
        model: provider.model,
        attempt,
        iteration: context.iteration,
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  try {
    return { response: await invoke(), attempts };
  } catch (error) {
    if (error instanceof LlmError && !error.retryable) throw error;

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return { response: await invoke(), attempts };
  }
}

function addAttemptUsage(
  total: QueryUsage,
  attempt: {
    usage: Awaited<ReturnType<LlmProvider["complete"]>>["usage"];
    cost: AttemptCost;
  },
): void {
  total.attempts++;
  total.inputTokens += attempt.usage?.inputTokens ?? 0;
  total.outputTokens += attempt.usage?.outputTokens ?? 0;
  total.cacheReadTokens += attempt.usage?.cacheReadTokens ?? 0;
  total.inputCostUsd = addUsd(total.inputCostUsd, attempt.cost.inputCostUsd);
  total.outputCostUsd = addUsd(total.outputCostUsd, attempt.cost.outputCostUsd);
  total.cacheReadCostUsd = addUsd(
    total.cacheReadCostUsd,
    attempt.cost.cacheReadCostUsd,
  );
  total.totalCostUsd = addUsd(
    addUsd(total.inputCostUsd, total.outputCostUsd),
    total.cacheReadCostUsd,
  );
}

function collectIssues(record: ToolCallRecord, into: Issue[]): void {
  if (!record.result.ok) return;
  if (
    record.toolName !== "reconcile_order" &&
    record.toolName !== "search_orders"
  ) {
    return;
  }

  const data = record.result.data as Record<string, unknown>;

  if (Array.isArray(data.issues)) {
    into.push(...(data.issues as Issue[]));
  }
  if (Array.isArray(data.orders)) {
    for (const order of data.orders as Record<string, unknown>[]) {
      if (Array.isArray(order.issues)) into.push(...(order.issues as Issue[]));
    }
  }
}
