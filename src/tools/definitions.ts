import { z } from "zod";
import {
  getAllSnapshots,
  getSnapshot,
  searchOrders,
} from "../repo/orders.ts";
import { reconcileOrder } from "../reconcile/rules.ts";
import {
  RULE_IDS,
  severityRank,
  type Issue,
  type OrderSnapshot,
} from "../reconcile/types.ts";
import { defineTool, type ToolDefinition, type ToolResult } from "./types.ts";

const orderNoSchema = z.object({
  order_no: z
    .number()
    .int()
    .describe("The human-facing order number, e.g. 4521"),
});

const notFound = (orderNo: number): ToolResult => ({
  ok: false,
  reason: "not_found",
  message: "No order exists with order_no " + orderNo,
});

const summarize = (s: OrderSnapshot) => ({
  order_no: s.order.orderNo,
  order_status: s.order.status,
  payment_status: s.payment?.status ?? null,
  amount: s.payment?.amount ?? null,
  delivery_status: s.delivery?.status ?? null,
  scheduled_date: s.delivery?.scheduledDate ?? null,
  created_at: s.order.createdAt.toISOString(),
});

export const getOrderStatus = defineTool({
  name: "get_order_status",
  description:
    "Get the core record for a single order: its status, customer, vehicle " +
    "and creation date. Use this for questions about an order's overall " +
    "state. Does not include payment or delivery detail.",
  schema: orderNoSchema,
  cacheable: true,
  async execute({ order_no }) {
    const snapshot = await getSnapshot(order_no);
    if (!snapshot) return notFound(order_no);

    return {
      ok: true,
      data: {
        order_no: snapshot.order.orderNo,
        status: snapshot.order.status,
        customer_id: snapshot.order.customerId,
        vehicle_id: snapshot.order.vehicleId,
        created_at: snapshot.order.createdAt.toISOString(),
      },
    };
  },
});

export const getPaymentStatus = defineTool({
  name: "get_payment_status",
  description:
    "Get the payment record for a single order: status (pending, paid, " +
    "failed, refunded), amount, and when it was captured. Use this for any " +
    "question about money on an order.",
  schema: orderNoSchema,
  cacheable: true,
  async execute({ order_no }) {
    const snapshot = await getSnapshot(order_no);
    if (!snapshot) return notFound(order_no);

    if (!snapshot.payment) {
      return {
        ok: true,
        data: { order_no, payment: null, note: "No payment record exists." },
      };
    }

    return {
      ok: true,
      data: {
        order_no,
        status: snapshot.payment.status,
        amount: snapshot.payment.amount,
        paid_at: snapshot.payment.paidAt?.toISOString() ?? null,
      },
    };
  },
});

export const getDeliveryStatus = defineTool({
  name: "get_delivery_status",
  description:
    "Get the delivery record for a single order: status (not_scheduled, " +
    "scheduled, out_for_delivery, delivered, delayed), the scheduled date, " +
    "and when it was delivered. Use this for logistics questions.",
  schema: orderNoSchema,
  cacheable: true,
  async execute({ order_no }) {
    const snapshot = await getSnapshot(order_no);
    if (!snapshot) return notFound(order_no);

    if (!snapshot.delivery) {
      return {
        ok: true,
        data: { order_no, delivery: null, note: "No delivery record exists." },
      };
    }

    return {
      ok: true,
      data: {
        order_no,
        status: snapshot.delivery.status,
        scheduled_date: snapshot.delivery.scheduledDate,
        delivered_at: snapshot.delivery.deliveredAt?.toISOString() ?? null,
      },
    };
  },
});

export const getOrderTimeline = defineTool({
  name: "get_order_timeline",
  description:
    "Get the full chronological event history for one order (payment " +
    "captured, delivery scheduled, delayed, cancelled, and so on). Use this " +
    "to explain HOW an order reached its current state, or when the user " +
    "asks what happened or what is going on with an order.",
  schema: orderNoSchema,
  cacheable: true,
  async execute({ order_no }) {
    const snapshot = await getSnapshot(order_no);
    if (!snapshot) return notFound(order_no);

    return {
      ok: true,
      data: {
        order_no,
        events: snapshot.events.map((e) => ({
          event_type: e.eventType,
          payload: e.payload,
          at: e.createdAt.toISOString(),
        })),
      },
    };
  },
});

export const reconcileOrderTool = defineTool({
  name: "reconcile_order",
  description:
    "Run all cross-system consistency checks on one order and return any " +
    "detected issues with severity and supporting evidence. Use this " +
    "whenever the user asks whether something is wrong, stuck, delayed, or " +
    "inconsistent with a specific order. Returns an empty list when the " +
    "order is healthy.",
  schema: orderNoSchema,
  cacheable: true,
  async execute({ order_no }) {
    const snapshot = await getSnapshot(order_no);
    if (!snapshot) return notFound(order_no);

    const issues = reconcileOrder(snapshot);
    return {
      ok: true,
      data: {
        order_no,
        issue_count: issues.length,
        issues,
        summary: summarize(snapshot),
      },
    };
  },
});

const searchSchema = z.object({
  order_status: z
    .array(z.enum(["placed", "confirmed", "cancelled", "completed"]))
    .optional()
    .describe("Restrict to these order statuses."),
  payment_status: z
    .array(z.enum(["pending", "paid", "failed", "refunded"]))
    .optional()
    .describe("Restrict to these payment statuses."),
  delivery_status: z
    .array(
      z.enum([
        "not_scheduled",
        "scheduled",
        "out_for_delivery",
        "delivered",
        "delayed",
      ]),
    )
    .optional()
    .describe("Restrict to these delivery statuses."),
  has_issue: z
    .enum(RULE_IDS)
    .optional()
    .describe(
      "Return only orders where this specific reconciliation rule fires.",
    ),
  created_after: z.string().optional().describe("ISO date lower bound."),
  created_before: z.string().optional().describe("ISO date upper bound."),
  scheduled_after: z.string().optional().describe("ISO date lower bound."),
  scheduled_before: z.string().optional().describe("ISO date upper bound."),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const searchOrdersTool = defineTool({
  name: "search_orders",
  description:
    "Find orders matching a set of filters, for questions about groups of " +
    "orders rather than one specific order ('which orders are paid but not " +
    "scheduled', 'show me delayed deliveries'). Filter by status on any of " +
    "the three systems, by date range, or by which reconciliation issue " +
    "fires. Results are capped, so state the cap if it is reached.",
  schema: searchSchema,
  cacheable: true,
  async execute(args) {
    
    const widened = args.has_issue
      ? { ...args, limit: 100 }
      : { ...args, limit: args.limit };

    const snapshots = await searchOrders({
      orderStatus: widened.order_status,
      paymentStatus: widened.payment_status,
      deliveryStatus: widened.delivery_status,
      createdAfter: widened.created_after,
      createdBefore: widened.created_before,
      scheduledAfter: widened.scheduled_after,
      scheduledBefore: widened.scheduled_before,
      limit: widened.limit,
    });

    let matched: { snapshot: OrderSnapshot; issues: Issue[] }[] = snapshots.map(
      (s) => ({ snapshot: s, issues: [] }),
    );

    if (args.has_issue) {
      const now = new Date();
      matched = snapshots
        .map((s) => ({ snapshot: s, issues: reconcileOrder(s, now) }))
        .filter((m) => m.issues.some((i) => i.ruleId === args.has_issue))
        .slice(0, args.limit);
    }

    return {
      ok: true,
      data: {
        count: matched.length,
        limit: args.limit,
        truncated: matched.length >= args.limit,
        orders: matched.map((m) => ({
          ...summarize(m.snapshot),
          ...(args.has_issue ? { issues: m.issues } : {}),
        })),
      },
    };
  },
});

export const reconcileFleetTool = defineTool({
  name: "reconcile_fleet",
  description:
    "Run every consistency check across ALL orders and return issues grouped " +
    "by rule, ranked by severity. Use this for broad questions like 'what is " +
    "broken right now', 'what needs attention today', or 'give me a health " +
    "summary'. Do not use it for a single named order.",
  schema: z.object({
    severity: z
      .enum(["critical", "warning", "info"])
      .optional()
      .describe("Restrict to issues at this severity."),
    limit_per_rule: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("How many example order numbers to list per rule."),
  }),
  cacheable: true,
  async execute({ severity, limit_per_rule }) {
    const snapshots = await getAllSnapshots();
    const now = new Date();

    const groups = new Map<string, { issue: Issue; orderNo: number }[]>();
    let totalIssues = 0;
    let affectedOrders = 0;

    for (const snapshot of snapshots) {
      const issues = reconcileOrder(snapshot, now).filter(
        (i) => !severity || i.severity === severity,
      );
      if (issues.length > 0) affectedOrders++;

      for (const issue of issues) {
        totalIssues++;
        const list = groups.get(issue.ruleId) ?? [];
        list.push({ issue, orderNo: snapshot.order.orderNo });
        groups.set(issue.ruleId, list);
      }
    }

    const byRule = [...groups.entries()]
      .map(([ruleId, entries]) => ({
        rule_id: ruleId,
        severity: entries[0]!.issue.severity,
        title: entries[0]!.issue.title,
        count: entries.length,
        example_order_nos: entries
          .slice(0, limit_per_rule)
          .map((e) => e.orderNo),
      }))
      .sort(
        (a, b) =>
          severityRank[a.severity] - severityRank[b.severity] ||
          b.count - a.count,
      );

    return {
      ok: true,
      data: {
        orders_scanned: snapshots.length,
        orders_with_issues: affectedOrders,
        total_issues: totalIssues,
        by_rule: byRule,
      },
    };
  },
});

export const ALL_TOOLS: ToolDefinition[] = [
  getOrderStatus,
  getPaymentStatus,
  getDeliveryStatus,
  getOrderTimeline,
  reconcileOrderTool,
  searchOrdersTool,
  reconcileFleetTool,
];
