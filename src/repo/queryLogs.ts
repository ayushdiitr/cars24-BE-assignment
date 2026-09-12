import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { queryHistory, queryLogs } from "../../db/schema.ts";
import type { AgentAnswer } from "../agent/orchestrator.ts";

export type QueryAttemptLog = {
  queryId: string;
  provider: string;
  model: string;
  attempt: number;
  iteration: number;
  status: string;
  stopReason?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  inputCostUsd?: string | null | undefined;
  outputCostUsd?: string | null | undefined;
  cacheReadCostUsd?: string | null | undefined;
  totalCostUsd?: string | null | undefined;
  durationMs: number;
  error?: string | undefined;
};

export async function persistQueryAttempt(attempt: QueryAttemptLog): Promise<void> {
  try {
    await db.insert(queryLogs).values({
      queryId: attempt.queryId,
      provider: attempt.provider,
      model: attempt.model,
      attempt: attempt.attempt,
      iteration: attempt.iteration,
      status: attempt.status,
      ...(attempt.stopReason !== undefined ? { stopReason: attempt.stopReason } : {}),
      ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
      ...(attempt.outputTokens !== undefined ? { outputTokens: attempt.outputTokens } : {}),
      ...(attempt.cacheReadTokens !== undefined
        ? { cacheReadTokens: attempt.cacheReadTokens }
        : {}),
      ...(attempt.inputCostUsd !== undefined ? { inputCostUsd: attempt.inputCostUsd } : {}),
      ...(attempt.outputCostUsd !== undefined ? { outputCostUsd: attempt.outputCostUsd } : {}),
      ...(attempt.cacheReadCostUsd !== undefined
        ? { cacheReadCostUsd: attempt.cacheReadCostUsd }
        : {}),
      ...(attempt.totalCostUsd !== undefined ? { totalCostUsd: attempt.totalCostUsd } : {}),
      durationMs: attempt.durationMs,
      ...(attempt.error !== undefined ? { error: attempt.error } : {}),
    });
  } catch (error) {
    console.error("[query_logs] failed to persist attempt", {
      queryId: attempt.queryId,
      attempt: attempt.attempt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getQueryLogs(queryId: string) {
  return db
    .select()
    .from(queryLogs)
    .where(eq(queryLogs.queryId, queryId))
    .orderBy(asc(queryLogs.attempt));
}

export async function persistQueryHistory(
  query: string,
  result: AgentAnswer,
  provider: { name: string; model: string },
): Promise<void> {
  try {
    await db.insert(queryHistory).values({
      queryId: result.queryId,
      query,
      answer: result.answer,
      issues: result.issues,
      toolCalls: result.toolCalls,
      meta: {
        iterations: result.iterations,
        degraded: result.degraded,
        provider: provider.name,
        model: provider.model,
        usage: result.usage,
      },
    });
  } catch (error) {
    console.error("[query_history] failed to persist query", {
      queryId: result.queryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listQueryHistory(limit: number) {
  return db
    .select()
    .from(queryHistory)
    .orderBy(desc(queryHistory.createdAt))
    .limit(limit);
}

export async function getQueryHistory(queryId: string) {
  const rows = await db
    .select()
    .from(queryHistory)
    .where(eq(queryHistory.queryId, queryId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getCostReport() {
  const attempts = await db
    .select()
    .from(queryLogs)
    .orderBy(desc(queryLogs.createdAt));
  const history = await listQueryHistory(100);
  const queryText = new Map(history.map((item) => [item.queryId, item.query]));
  const byQuery = new Map<
    string,
    {
      queryId: string;
      query: string | null;
      provider: string;
      model: string;
      attempts: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      totalCostUsd: number | null;
      createdAt: Date;
    }
  >();

  for (const attempt of attempts) {
    const current = byQuery.get(attempt.queryId) ?? {
      queryId: attempt.queryId,
      query: queryText.get(attempt.queryId) ?? null,
      provider: attempt.provider,
      model: attempt.model,
      attempts: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalCostUsd: 0,
      createdAt: attempt.createdAt,
    };
    current.attempts++;
    current.inputTokens += attempt.inputTokens ?? 0;
    current.outputTokens += attempt.outputTokens ?? 0;
    current.cacheReadTokens += attempt.cacheReadTokens ?? 0;
    current.createdAt = attempt.createdAt > current.createdAt
      ? attempt.createdAt
      : current.createdAt;
    current.totalCostUsd =
      current.totalCostUsd === null || attempt.totalCostUsd === null
        ? null
        : current.totalCostUsd + Number(attempt.totalCostUsd);
    byQuery.set(attempt.queryId, current);
  }

  const queries = [...byQuery.values()].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  );
  const knownCosts = queries.filter((item) => item.totalCostUsd !== null);

  return {
    totalQueries: queries.length,
    totalAttempts: attempts.length,
    inputTokens: queries.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: queries.reduce((sum, item) => sum + item.outputTokens, 0),
    cacheReadTokens: queries.reduce((sum, item) => sum + item.cacheReadTokens, 0),
    totalCostUsd:
      knownCosts.length === queries.length
        ? knownCosts.reduce((sum, item) => sum + item.totalCostUsd!, 0).toFixed(6)
        : null,
    hasUnpricedQueries: knownCosts.length !== queries.length,
    queries: queries.map((item) => ({
      ...item,
      totalCostUsd: item.totalCostUsd?.toFixed(6) ?? null,
      createdAt: item.createdAt.toISOString(),
    })),
  };
}