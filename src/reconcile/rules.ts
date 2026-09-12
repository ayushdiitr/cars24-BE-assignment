import {
  severityRank,
  type Issue,
  type OrderSnapshot,
  type Rule,
} from "./types.ts";


export const PAID_NOT_SCHEDULED_GRACE_DAYS = Number(
  process.env.PAID_NOT_SCHEDULED_GRACE_DAYS ?? 3,
);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (from: Date, to: Date) =>
  Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);

const startOfUtcDay = (d: Date) =>
  Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

const parseScheduledDate = (value: string | null): Date | null =>
  value ? new Date(value + "T00:00:00Z") : null;

const hasEvent = (snapshot: OrderSnapshot, ...types: string[]) =>
  snapshot.events.some((e) => types.includes(e.eventType));

const reasonOf = (event: { payload: unknown } | undefined): string | null =>
  (event?.payload as { reason?: string } | undefined)?.reason ?? null;


export const RULES: Rule[] = [
  {
    // The example from the brief: money captured, nothing moving.
    id: "payment_captured_delivery_not_scheduled",
    severity: "critical",
    evaluate(snapshot, now) {
      const { order, payment, delivery } = snapshot;
      if (order.status === "cancelled") return null;
      if (payment?.status !== "paid" || !payment.paidAt) return null;
      if (delivery?.status !== "not_scheduled") return null;

      const daysSincePaid = daysBetween(payment.paidAt, now);
      if (daysSincePaid <= PAID_NOT_SCHEDULED_GRACE_DAYS) return null;

      return {
        title: "Payment captured but delivery never scheduled",
        detail:
          "Payment of " + payment.amount + " was captured " + daysSincePaid +
          " days ago, but the delivery is still marked not_scheduled.",
        evidence: {
          amount: payment.amount,
          paidAt: payment.paidAt.toISOString(),
          daysSincePaid,
          deliveryStatus: delivery.status,
          graceDays: PAID_NOT_SCHEDULED_GRACE_DAYS,
        },
      };
    },
  },

  {
    // Vehicle handed over without the money settled — direct revenue leak.
    id: "delivered_without_payment",
    severity: "critical",
    evaluate(snapshot) {
      const { payment, delivery } = snapshot;
      if (delivery?.status !== "delivered") return null;
      if (payment?.status === "paid") return null;

      return {
        title: "Delivered without full payment",
        detail:
          "Delivery is marked delivered but payment status is " +
          (payment?.status ?? "missing") + ".",
        evidence: {
          deliveryStatus: delivery.status,
          deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
          paymentStatus: payment?.status ?? null,
          amount: payment?.amount ?? null,
        },
      };
    },
  },

  {
    // Cancelled, but the money was never sent back.
    id: "refund_pending_on_cancelled_order",
    severity: "critical",
    evaluate(snapshot, now) {
      const { order, payment } = snapshot;
      if (order.status !== "cancelled") return null;
      if (payment?.status !== "paid") return null;
      if (hasEvent(snapshot, "payment_refunded", "refund_initiated")) return null;

      const cancelledEvent = snapshot.events.find(
        (e) => e.eventType === "order_cancelled",
      );
      const daysSinceCancelled = cancelledEvent
        ? daysBetween(cancelledEvent.createdAt, now)
        : null;

      return {
        title: "Refund pending on cancelled order",
        detail:
          "Order was cancelled but payment of " + payment.amount +
          " is still marked paid with no refund recorded.",
        evidence: {
          orderStatus: order.status,
          paymentStatus: payment.status,
          amount: payment.amount,
          cancelledAt: cancelledEvent?.createdAt.toISOString() ?? null,
          daysSinceCancelled,
        },
      };
    },
  },

  {
    // SLA breach: the promised date has passed and the car hasn't moved.
    id: "delivery_overdue",
    severity: "warning",
    evaluate(snapshot, now) {
      const { delivery } = snapshot;
      if (!delivery || delivery.status === "delivered") return null;

      const scheduled = parseScheduledDate(delivery.scheduledDate);
      if (!scheduled) return null;
      if (startOfUtcDay(scheduled) >= startOfUtcDay(now)) return null;

      const daysOverdue = daysBetween(scheduled, now);
      return {
        title: "Delivery overdue",
        detail:
          "Delivery was scheduled for " + delivery.scheduledDate + " (" +
          daysOverdue + " days ago) but status is still " +
          delivery.status + ".",
        evidence: {
          scheduledDate: delivery.scheduledDate,
          daysOverdue,
          deliveryStatus: delivery.status,
        },
      };
    },
  },

  {
    // Marked delayed and then dropped — no new date was ever set.
    id: "delayed_without_reschedule",
    severity: "warning",
    evaluate(snapshot, now) {
      const { delivery } = snapshot;
      if (delivery?.status !== "delayed") return null;
      if (delivery.scheduledDate !== null) return null;

      const delayEvent = [...snapshot.events]
        .reverse()
        .find((e) => e.eventType === "delivery_delayed");

      return {
        title: "Delivery delayed with no new date",
        detail:
          "Delivery is marked delayed but has no scheduled_date, so nothing " +
          "will trigger a follow-up.",
        evidence: {
          deliveryStatus: delivery.status,
          scheduledDate: null,
          delayedAt: delayEvent?.createdAt.toISOString() ?? null,
          daysSinceDelayed: delayEvent
            ? daysBetween(delayEvent.createdAt, now)
            : null,
          reason: reasonOf(delayEvent),
        },
      };
    },
  },

  {
    // Payment bounced but the order is still sitting open in the pipeline.
    id: "payment_failed_order_open",
    severity: "warning",
    evaluate(snapshot, now) {
      const { order, payment } = snapshot;
      if (payment?.status !== "failed") return null;
      if (order.status !== "placed" && order.status !== "confirmed") return null;

      const failedEvent = [...snapshot.events]
        .reverse()
        .find((e) => e.eventType === "payment_failed");

      return {
        title: "Payment failed but order still open",
        detail:
          "Payment failed yet the order remains " + order.status +
          "; it will neither progress nor be cancelled without intervention.",
        evidence: {
          orderStatus: order.status,
          paymentStatus: payment.status,
          amount: payment.amount,
          failedAt: failedEvent?.createdAt.toISOString() ?? null,
          daysSinceFailed: failedEvent
            ? daysBetween(failedEvent.createdAt, now)
            : null,
          reason: reasonOf(failedEvent),
        },
      };
    },
  },
];


export function reconcileOrder(
  snapshot: OrderSnapshot,
  now: Date = new Date(),
): Issue[] {
  const issues: Issue[] = [];

  for (const rule of RULES) {
    const result = rule.evaluate(snapshot, now);
    if (result) {
      issues.push({ ruleId: rule.id, severity: rule.severity, ...result });
    }
  }

  return issues.sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  );
}
