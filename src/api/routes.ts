import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/client.ts";
import { answerQuery } from "../agent/orchestrator.ts";
import type { LlmProvider } from "../llm/provider.ts";
import { reconcileOrder } from "../reconcile/rules.ts";
import { severityRank, type Issue } from "../reconcile/types.ts";
import {
  getAllSnapshots,
  getQueryTrace,
  getSnapshot,
} from "../repo/orders.ts";
import {
  getCostReport,
  getQueryHistory,
  getQueryLogs,
  listQueryHistory,
  persistQueryHistory,
} from "../repo/queryLogs.ts";
import { TokenBucket } from "../rateLimit.ts";

const querySchema = z.object({
  query: z.string().min(1).max(2000),
});

const orderNoSchema = z.object({
  orderNo: z.coerce.number().int(),
});

export type RouteOptions = {
  
  getProvider: () => LlmProvider;
};

export async function registerRoutes(
  server: FastifyInstance,
  options: RouteOptions,
): Promise<void> {
  const limiter = new TokenBucket();

  server.get("/health", async (_request, reply) => {
    try {
      await db.execute("SELECT 1");
    } catch (error) {
     
      return reply.status(503).send({
        status: "error",
        database: "unreachable",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { status: "ok", database: "connected" };
  });

 
  server.post("/api/query", async (request, reply) => {
    const limit = limiter.take(request.ip);
    if (!limit.allowed) {
      return reply
        .status(429)
        .header("retry-after", Math.ceil(limit.retryAfterMs / 1000))
        .send({
          error: "rate_limited",
          message:
            "Too many queries. Each one costs a model call; retry in " +
            Math.ceil(limit.retryAfterMs / 1000) +
            "s.",
        });
    }

    const parsed = querySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "Body must be { query: string } with 1-2000 characters.",
        issues: parsed.error.issues,
      });
    }

    let provider: LlmProvider;
    try {
      provider = options.getProvider();
    } catch (error) {
      return reply.status(503).send({
        error: "llm_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const result = await answerQuery(parsed.data.query, provider);
    await persistQueryHistory(parsed.data.query, result, provider);
    return reply.send({
      queryId: result.queryId,
      answer: result.answer,
      issues: result.issues,
      toolCalls: result.toolCalls.map((call) => ({
        tool: call.toolName,
        arguments: call.arguments,
        durationMs: call.durationMs,
        cached: call.cached,
        ok: call.result.ok,
        result: call.result,
      })),
      meta: {
        iterations: result.iterations,
        degraded: result.degraded,
        provider: provider.name,
        model: provider.model,
        usage: result.usage,
      },
    });
  });

  server.get("/api/queries", async (request, reply) => {
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
      .safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_limit" });
    }

    const history = await listQueryHistory(parsed.data.limit);
    return {
      queries: history.map((item) => ({
        queryId: item.queryId,
        query: item.query,
        answer: item.answer,
        issueCount: Array.isArray(item.issues) ? item.issues.length : 0,
        toolCallCount: Array.isArray(item.toolCalls) ? item.toolCalls.length : 0,
        meta: item.meta,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });

  server.get("/api/queries/:queryId", async (request, reply) => {
    const parsed = z
      .object({ queryId: z.string().uuid() })
      .safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query_id" });
    }

    const item = await getQueryHistory(parsed.data.queryId);
    if (!item) {
      return reply.status(404).send({
        error: "not_found",
        message: "No saved query with that query id.",
      });
    }

    const toolCalls = Array.isArray(item.toolCalls) ? item.toolCalls : [];
    return {
      queryId: item.queryId,
      query: item.query,
      answer: item.answer,
      issues: item.issues,
      toolCalls: toolCalls.map((call) => {
        const record = call as Record<string, unknown>;
        const result = record.result as { ok?: boolean } | undefined;
        return {
          tool: record.toolName,
          arguments: record.arguments,
          durationMs: record.durationMs,
          cached: record.cached,
          ok: result?.ok ?? false,
          result: record.result,
        };
      }),
      meta: item.meta,
      createdAt: item.createdAt.toISOString(),
    };
  });

  server.get("/api/costs", async () => getCostReport());

  server.get("/api/orders/:orderNo", async (request, reply) => {
    const parsed = orderNoSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_order_no" });
    }

    const snapshot = await getSnapshot(parsed.data.orderNo);
    if (!snapshot) {
      return reply.status(404).send({
        error: "not_found",
        message: "No order with order_no " + parsed.data.orderNo,
      });
    }

    return {
      order: snapshot.order,
      payment: snapshot.payment,
      delivery: snapshot.delivery,
      events: snapshot.events,
    };
  });

  /** The rule engine, reachable without the LLM in the path. */
  server.get("/api/orders/:orderNo/reconcile", async (request, reply) => {
    const parsed = orderNoSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_order_no" });
    }

    const snapshot = await getSnapshot(parsed.data.orderNo);
    if (!snapshot) {
      return reply.status(404).send({
        error: "not_found",
        message: "No order with order_no " + parsed.data.orderNo,
      });
    }

    const issues = reconcileOrder(snapshot);
    return {
      order_no: parsed.data.orderNo,
      healthy: issues.length === 0,
      issue_count: issues.length,
      issues,
    };
  });

  server.get("/api/reconcile", async (request, reply) => {
    const query = z
      .object({ severity: z.enum(["critical", "warning", "info"]).optional() })
      .safeParse(request.query);

    if (!query.success) {
      return reply.status(400).send({ error: "invalid_severity" });
    }

    const snapshots = await getAllSnapshots();
    const now = new Date();
    const flagged: { order_no: number; issues: Issue[] }[] = [];
    const counts = new Map<string, number>();

    for (const snapshot of snapshots) {
      const issues = reconcileOrder(snapshot, now).filter(
        (issue) => !query.data.severity || issue.severity === query.data.severity,
      );
      if (issues.length === 0) continue;

      flagged.push({ order_no: snapshot.order.orderNo, issues });
      for (const issue of issues) {
        counts.set(issue.ruleId, (counts.get(issue.ruleId) ?? 0) + 1);
      }
    }

    flagged.sort(
      (a, b) =>
        severityRank[a.issues[0]!.severity] -
        severityRank[b.issues[0]!.severity],
    );

    return {
      orders_scanned: snapshots.length,
      orders_with_issues: flagged.length,
      total_issues: [...counts.values()].reduce((a, b) => a + b, 0),
      counts_by_rule: Object.fromEntries(counts),
      orders: flagged,
    };
  });

  /** Replay what the agent did for a past query. */
  server.get("/api/queries/:queryId/trace", async (request, reply) => {
    const parsed = z
      .object({ queryId: z.string().uuid() })
      .safeParse(request.params);

    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query_id" });
    }

    const [trace, queryLogs] = await Promise.all([
      getQueryTrace(parsed.data.queryId),
      getQueryLogs(parsed.data.queryId),
    ]);
    if (trace.length === 0 && queryLogs.length === 0) {
      return reply.status(404).send({
        error: "not_found",
        message: "No tool calls recorded for that query id.",
      });
    }

    return {
      query_id: parsed.data.queryId,
      call_count: trace.length,
      total_duration_ms: trace.reduce((sum, row) => sum + row.durationMs, 0),
      llm_attempt_count: queryLogs.length,
      llm_attempts: queryLogs,
      calls: trace.map((row) => ({
        tool: row.toolName,
        arguments: row.arguments,
        result: row.result,
        duration_ms: row.durationMs,
        at: row.createdAt.toISOString(),
      })),
    };
  });
}
