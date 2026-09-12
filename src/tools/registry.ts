import { randomUUID } from "node:crypto";
import { db } from "../../db/client.ts";
import { toolCallLogs } from "../../db/schema.ts";
import { TtlCache, stableKey } from "../cache.ts";
import { ALL_TOOLS } from "./definitions.ts";
import type { ToolCallRecord, ToolDefinition, ToolResult } from "./types.ts";



const registry = new Map<string, ToolDefinition>(
  ALL_TOOLS.map((tool) => [tool.name, tool]),
);

const cache = new TtlCache();

export const getTool = (name: string) => registry.get(name);
export const listTools = (): ToolDefinition[] => [...registry.values()];
export const clearToolCache = () => cache.clear();

export type RunToolOptions = {
  queryId?: string;
  useCache?: boolean;
};

export async function runTool(
  toolName: string,
  rawArgs: unknown,
  options: RunToolOptions = {},
): Promise<ToolCallRecord> {
  const { queryId = randomUUID(), useCache = true } = options;
  const startedAt = performance.now();

  const record = (result: ToolResult, cached: boolean): ToolCallRecord => ({
    toolName,
    arguments: rawArgs,
    result,
    durationMs: Math.round(performance.now() - startedAt),
    cached,
  });

  const tool = registry.get(toolName);
  if (!tool) {
  
    const result: ToolResult = {
      ok: false,
      reason: "execution_error",
      message:
        "Unknown tool '" + toolName + "'. Available tools: " +
        [...registry.keys()].join(", "),
    };
    const call = record(result, false);
    await persist(queryId, call);
    return call;
  }

  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const result: ToolResult = {
      ok: false,
      reason: "invalid_arguments",
      message:
        "Arguments did not match the schema for " + toolName + ". " +
        "Correct them and call the tool again.",
      issues: parsed.error.issues,
    };
    const call = record(result, false);
    await persist(queryId, call);
    return call;
  }

  const key = stableKey(toolName, parsed.data);
  if (useCache && tool.cacheable) {
    const hit = cache.get<ToolResult>(key);
    if (hit) {
      const call = record(hit, true);
      await persist(queryId, call);
      return call;
    }
  }

  let result: ToolResult;
  try {
    result = await tool.execute(parsed.data);
  } catch (error) {
  
    result = {
      ok: false,
      reason: "execution_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (useCache && tool.cacheable && result.ok) cache.set(key, result);

  const call = record(result, false);
  await persist(queryId, call);
  return call;
}


async function persist(queryId: string, call: ToolCallRecord): Promise<void> {
  try {
    await db.insert(toolCallLogs).values({
      queryId,
      toolName: call.toolName,
      arguments: (call.arguments ?? {}) as Record<string, unknown>,
      result: call.result as unknown as Record<string, unknown>,
      durationMs: call.durationMs,
    });
  } catch (error) {
    console.error("[tool_call_logs] failed to persist call", {
      toolName: call.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
