import type { z } from "zod";


export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: "not_found"; message: string }
  | { ok: false; reason: "invalid_arguments"; message: string; issues: unknown }
  | { ok: false; reason: "execution_error"; message: string };

export type ToolDefinition<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  execute(args: z.infer<S>): Promise<ToolResult>;
  cacheable: boolean;
};

export type ToolCallRecord = {
  toolName: string;
  arguments: unknown;
  result: ToolResult;
  durationMs: number;
  cached: boolean;
};


export function defineTool<S extends z.ZodType>(
  def: ToolDefinition<S>,
): ToolDefinition {
  return def as unknown as ToolDefinition;
}
