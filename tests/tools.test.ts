import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "../db/client.ts";
import { clearToolCache, runTool } from "../src/tools/registry.ts";

/**
 * These run against the seeded database. Order numbers referenced here are
 * stable because the seed uses a fixed-seed PRNG.
 *
 * Requires: npm run db:up && npm run db:migrate && npm run db:seed
 */

const PAID_NOT_SCHEDULED = 4500;
const DELIVERED_UNPAID = 4509;
const FRESH_ORDER = 4506;
const CANCELLED_UNREFUNDED = 4504;

beforeEach(() => clearToolCache());
afterAll(async () => {
  await sql.end();
});

const data = (r: Awaited<ReturnType<typeof runTool>>) => {
  if (!r.result.ok) throw new Error("expected ok result, got " + r.result.reason);
  return r.result.data as Record<string, unknown>;
};

describe("single-order lookup tools", () => {
  it("returns order, payment and delivery for a real order", async () => {
    const order = await runTool("get_order_status", { order_no: PAID_NOT_SCHEDULED });
    expect(data(order)).toMatchObject({ order_no: PAID_NOT_SCHEDULED });

    const payment = await runTool("get_payment_status", { order_no: PAID_NOT_SCHEDULED });
    expect(data(payment)).toMatchObject({ status: "paid" });

    const delivery = await runTool("get_delivery_status", { order_no: PAID_NOT_SCHEDULED });
    expect(data(delivery)).toMatchObject({ status: "not_scheduled" });
  });

  it("returns a chronological timeline", async () => {
    const result = await runTool("get_order_timeline", { order_no: PAID_NOT_SCHEDULED });
    const events = data(result).events as { at: string }[];

    expect(events.length).toBeGreaterThan(0);
    const times = events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns a typed not_found rather than throwing", async () => {
    const result = await runTool("get_order_status", { order_no: 999999 });
    expect(result.result).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("reconcile_order", () => {
  it("detects the paid-but-not-scheduled order", async () => {
    const result = await runTool("reconcile_order", { order_no: PAID_NOT_SCHEDULED });
    const issues = data(result).issues as { ruleId: string }[];
    expect(issues.map((i) => i.ruleId)).toContain(
      "payment_captured_delivery_not_scheduled",
    );
  });

  it("detects the delivered-but-unpaid order", async () => {
    const result = await runTool("reconcile_order", { order_no: DELIVERED_UNPAID });
    const issues = data(result).issues as { ruleId: string }[];
    expect(issues.map((i) => i.ruleId)).toContain("delivered_without_payment");
  });

  it("detects the cancelled-but-unrefunded order", async () => {
    const result = await runTool("reconcile_order", { order_no: CANCELLED_UNREFUNDED });
    const issues = data(result).issues as { ruleId: string }[];
    expect(issues.map((i) => i.ruleId)).toContain(
      "refund_pending_on_cancelled_order",
    );
  });

  // The seed's deliberate trap: looks broken, isn't.
  it("reports nothing for a freshly placed order", async () => {
    const result = await runTool("reconcile_order", { order_no: FRESH_ORDER });
    expect(data(result).issue_count).toBe(0);
  });
});

describe("search_orders", () => {
  it("filters by cross-system status", async () => {
    const result = await runTool("search_orders", {
      payment_status: ["paid"],
      delivery_status: ["not_scheduled"],
      limit: 50,
    });
    const orders = data(result).orders as Record<string, string>[];

    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      expect(o.payment_status).toBe("paid");
      expect(o.delivery_status).toBe("not_scheduled");
    }
  });

  it("filters by which reconciliation rule fires", async () => {
    const result = await runTool("search_orders", {
      has_issue: "delivered_without_payment",
      limit: 50,
    });
    const orders = data(result).orders as Record<string, unknown>[];

    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) {
      expect(o.delivery_status).toBe("delivered");
      expect(o.payment_status).not.toBe("paid");
    }
  });

  it("respects the limit", async () => {
    const result = await runTool("search_orders", { limit: 3 });
    expect((data(result).orders as unknown[]).length).toBe(3);
  });
});

describe("reconcile_fleet", () => {
  it("scans every order and groups issues by rule, criticals first", async () => {
    const result = await runTool("reconcile_fleet", {});
    const d = data(result);

    expect(d.orders_scanned).toBe(77);
    const byRule = d.by_rule as { severity: string; count: number }[];
    expect(byRule.length).toBeGreaterThan(0);

    const rank = { critical: 0, warning: 1, info: 2 } as Record<string, number>;
    const ranks = byRule.map((r) => rank[r.severity]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("filters by severity", async () => {
    const result = await runTool("reconcile_fleet", { severity: "critical" });
    const byRule = data(result).by_rule as { severity: string }[];
    for (const r of byRule) expect(r.severity).toBe("critical");
  });
});

describe("the runTool chokepoint", () => {
  it("rejects invalid arguments with a recoverable error, not a throw", async () => {
    const result = await runTool("get_order_status", { order_no: "not-a-number" });
    expect(result.result).toMatchObject({
      ok: false,
      reason: "invalid_arguments",
    });
  });

  it("rejects an unknown tool and names the real ones", async () => {
    const result = await runTool("drop_all_tables", {});
    expect(result.result.ok).toBe(false);
    if (!result.result.ok) {
      expect(result.result.message).toContain("get_order_status");
    }
  });

  it("serves a repeat call from cache", async () => {
    const first = await runTool("get_order_status", { order_no: PAID_NOT_SCHEDULED });
    const second = await runTool("get_order_status", { order_no: PAID_NOT_SCHEDULED });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.result).toEqual(first.result);
  });

  it("does not let key ordering cause a cache miss", async () => {
    await runTool("search_orders", { limit: 5, payment_status: ["paid"] });
    const second = await runTool("search_orders", { payment_status: ["paid"], limit: 5 });
    expect(second.cached).toBe(true);
  });

  it("records every call against its query id", async () => {
    // Fresh id per run: tool_call_logs is append-only, so a fixed id would
    // accumulate rows across runs and pass only on a clean database.
    const queryId = randomUUID();
    await runTool("get_order_status", { order_no: PAID_NOT_SCHEDULED }, { queryId });
    await runTool("get_payment_status", { order_no: PAID_NOT_SCHEDULED }, { queryId });

    const { getQueryTrace } = await import("../src/repo/orders.ts");
    const trace = await getQueryTrace(queryId);

    expect(trace.map((t) => t.toolName)).toEqual([
      "get_order_status",
      "get_payment_status",
    ]);
    for (const row of trace) {
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
