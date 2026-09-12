import type {
  Delivery,
  Order,
  OrderEvent,
  Payment,
} from "../../db/schema.ts";


export type OrderSnapshot = {
  order: Order;
  payment: Payment | null;
  delivery: Delivery | null;
  events: OrderEvent[];
};

export const SEVERITIES = ["critical", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RULE_IDS = [
  "payment_captured_delivery_not_scheduled",
  "delivered_without_payment",
  "refund_pending_on_cancelled_order",
  "delivery_overdue",
  "delayed_without_reschedule",
  "payment_failed_order_open",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type Issue = {
  ruleId: RuleId;
  severity: Severity;
  title: string;
  detail: string;
 
  evidence: Record<string, unknown>;
};

export type Rule = {
  id: RuleId;
  severity: Severity;
  evaluate(snapshot: OrderSnapshot, now: Date): Omit<Issue, "ruleId" | "severity"> | null;
};

export const severityRank: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};
