import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  PAID_NOT_SCHEDULED_GRACE_DAYS,
  RULES,
  reconcileOrder,
} from "../src/reconcile/rules.ts";
import { RULE_IDS, type OrderSnapshot } from "../src/reconcile/types.ts";
import type {
  Delivery,
  Order,
  OrderEvent,
  Payment,
} from "../db/schema.ts";

// Fixed clock. Every date below is expressed relative to it, so the
// date-sensitive rules are deterministic rather than "passes until next week".
const NOW = new Date("2026-09-12T10:00:00Z");
const ORDER_ID = "11111111-1111-1111-1111-111111111111";

const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    orderNo: 4521,
    customerId: randomUUID(),
    vehicleId: randomUUID(),
    status: "confirmed",
    createdAt: daysAgo(30),
    ...over,
  };
}

function makePayment(over: Partial<Payment> = {}): Payment {
  return {
    id: randomUUID(),
    orderId: ORDER_ID,
    amount: "450000.00",
    status: "paid",
    paidAt: daysAgo(29),
    ...over,
  };
}

function makeDelivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: randomUUID(),
    orderId: ORDER_ID,
    status: "not_scheduled",
    scheduledDate: null,
    deliveredAt: null,
    ...over,
  };
}

function makeEvent(
  eventType: string,
  createdAt: Date,
  payload: Record<string, unknown> = {},
): OrderEvent {
  return { id: randomUUID(), orderId: ORDER_ID, eventType, payload, createdAt };
}

function snapshot(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    order: makeOrder(),
    payment: makePayment(),
    delivery: makeDelivery(),
    events: [],
    ...over,
  };
}

const ruleIdsFor = (s: OrderSnapshot) =>
  reconcileOrder(s, NOW).map((i) => i.ruleId);

describe("payment_captured_delivery_not_scheduled", () => {
  it("fires when a captured payment has sat unscheduled past the grace period", () => {
    const issues = reconcileOrder(
      snapshot({
        payment: makePayment({ status: "paid", paidAt: daysAgo(30) }),
        delivery: makeDelivery({ status: "not_scheduled" }),
      }),
      NOW,
    );

    const issue = issues.find(
      (i) => i.ruleId === "payment_captured_delivery_not_scheduled",
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("critical");
    // Evidence must carry the real values — this is what the LLM cites.
    expect(issue?.evidence).toMatchObject({
      amount: "450000.00",
      daysSincePaid: 30,
      deliveryStatus: "not_scheduled",
    });
  });

  it("does not fire inside the grace period", () => {
    const s = snapshot({
      payment: makePayment({
        status: "paid",
        paidAt: daysAgo(PAID_NOT_SCHEDULED_GRACE_DAYS),
      }),
    });
    expect(ruleIdsFor(s)).not.toContain(
      "payment_captured_delivery_not_scheduled",
    );
  });

  it("fires on the first day past the grace period", () => {
    const s = snapshot({
      payment: makePayment({
        status: "paid",
        paidAt: daysAgo(PAID_NOT_SCHEDULED_GRACE_DAYS + 1),
      }),
    });
    expect(ruleIdsFor(s)).toContain("payment_captured_delivery_not_scheduled");
  });

  it("does not fire when the payment has not been captured", () => {
    const s = snapshot({
      payment: makePayment({ status: "pending", paidAt: null }),
    });
    expect(ruleIdsFor(s)).not.toContain(
      "payment_captured_delivery_not_scheduled",
    );
  });

  it("defers to the refund rule on a cancelled order rather than double-reporting", () => {
    const s = snapshot({
      order: makeOrder({ status: "cancelled" }),
      payment: makePayment({ status: "paid", paidAt: daysAgo(30) }),
      delivery: makeDelivery({ status: "not_scheduled" }),
    });
    const ids = ruleIdsFor(s);
    expect(ids).not.toContain("payment_captured_delivery_not_scheduled");
    expect(ids).toContain("refund_pending_on_cancelled_order");
  });
});

describe("delivered_without_payment", () => {
  it("fires when a delivered order still has a pending payment", () => {
    const issues = reconcileOrder(
      snapshot({
        payment: makePayment({ status: "pending", paidAt: null }),
        delivery: makeDelivery({
          status: "delivered",
          deliveredAt: daysAgo(2),
          scheduledDate: isoDate(daysAgo(3)),
        }),
      }),
      NOW,
    );

    const issue = issues.find((i) => i.ruleId === "delivered_without_payment");
    expect(issue?.severity).toBe("critical");
    expect(issue?.evidence).toMatchObject({ paymentStatus: "pending" });
  });

  it("does not fire on the happy path", () => {
    const s = snapshot({
      order: makeOrder({ status: "completed" }),
      payment: makePayment({ status: "paid", paidAt: daysAgo(20) }),
      delivery: makeDelivery({
        status: "delivered",
        deliveredAt: daysAgo(5),
        scheduledDate: isoDate(daysAgo(6)),
      }),
    });
    expect(reconcileOrder(s, NOW)).toEqual([]);
  });
});

describe("refund_pending_on_cancelled_order", () => {
  it("fires when a cancelled order retains a captured payment", () => {
    const issues = reconcileOrder(
      snapshot({
        order: makeOrder({ status: "cancelled" }),
        payment: makePayment({ status: "paid", paidAt: daysAgo(20) }),
        events: [makeEvent("order_cancelled", daysAgo(6))],
      }),
      NOW,
    );

    const issue = issues.find(
      (i) => i.ruleId === "refund_pending_on_cancelled_order",
    );
    expect(issue?.severity).toBe("critical");
    expect(issue?.evidence).toMatchObject({ daysSinceCancelled: 6 });
  });

  it("does not fire once a refund event exists", () => {
    const s = snapshot({
      order: makeOrder({ status: "cancelled" }),
      payment: makePayment({ status: "paid", paidAt: daysAgo(20) }),
      events: [
        makeEvent("order_cancelled", daysAgo(6)),
        makeEvent("payment_refunded", daysAgo(5)),
      ],
    });
    expect(ruleIdsFor(s)).not.toContain("refund_pending_on_cancelled_order");
  });

  it("does not fire when the payment was already refunded in status", () => {
    const s = snapshot({
      order: makeOrder({ status: "cancelled" }),
      payment: makePayment({ status: "refunded" }),
    });
    expect(ruleIdsFor(s)).not.toContain("refund_pending_on_cancelled_order");
  });
});

describe("delivery_overdue", () => {
  it("fires when the scheduled date has passed and nothing was delivered", () => {
    const issues = reconcileOrder(
      snapshot({
        delivery: makeDelivery({
          status: "scheduled",
          scheduledDate: isoDate(daysAgo(4)),
        }),
      }),
      NOW,
    );

    const issue = issues.find((i) => i.ruleId === "delivery_overdue");
    expect(issue?.severity).toBe("warning");
    expect(issue?.evidence).toMatchObject({ daysOverdue: 4 });
  });

  it("does not fire for a future scheduled date", () => {
    const s = snapshot({
      delivery: makeDelivery({
        status: "scheduled",
        scheduledDate: isoDate(daysAhead(3)),
      }),
    });
    expect(ruleIdsFor(s)).not.toContain("delivery_overdue");
  });

  it("does not fire on the scheduled day itself", () => {
    const s = snapshot({
      delivery: makeDelivery({
        status: "scheduled",
        scheduledDate: isoDate(NOW),
      }),
    });
    expect(ruleIdsFor(s)).not.toContain("delivery_overdue");
  });

  it("does not fire once delivered, even if it landed late", () => {
    const s = snapshot({
      delivery: makeDelivery({
        status: "delivered",
        scheduledDate: isoDate(daysAgo(10)),
        deliveredAt: daysAgo(2),
      }),
    });
    expect(ruleIdsFor(s)).not.toContain("delivery_overdue");
  });
});

describe("delayed_without_reschedule", () => {
  it("fires when a delayed delivery has no new date", () => {
    const issues = reconcileOrder(
      snapshot({
        delivery: makeDelivery({ status: "delayed", scheduledDate: null }),
        events: [
          makeEvent("delivery_delayed", daysAgo(5), { reason: "rto_paperwork" }),
        ],
      }),
      NOW,
    );

    const issue = issues.find((i) => i.ruleId === "delayed_without_reschedule");
    expect(issue?.severity).toBe("warning");
    expect(issue?.evidence).toMatchObject({
      reason: "rto_paperwork",
      daysSinceDelayed: 5,
    });
  });

  it("does not fire once a new date is set", () => {
    const s = snapshot({
      delivery: makeDelivery({
        status: "delayed",
        scheduledDate: isoDate(daysAhead(4)),
      }),
    });
    expect(ruleIdsFor(s)).not.toContain("delayed_without_reschedule");
  });
});

describe("payment_failed_order_open", () => {
  it("fires when payment failed but the order is still open", () => {
    const issues = reconcileOrder(
      snapshot({
        order: makeOrder({ status: "placed" }),
        payment: makePayment({ status: "failed", paidAt: null }),
        delivery: makeDelivery({ status: "not_scheduled" }),
        events: [
          makeEvent("payment_failed", daysAgo(8), {
            reason: "insufficient_funds",
          }),
        ],
      }),
      NOW,
    );

    const issue = issues.find((i) => i.ruleId === "payment_failed_order_open");
    expect(issue?.evidence).toMatchObject({ reason: "insufficient_funds" });
  });

  it("does not fire once the order is cancelled", () => {
    const s = snapshot({
      order: makeOrder({ status: "cancelled" }),
      payment: makePayment({ status: "failed", paidAt: null }),
    });
    expect(ruleIdsFor(s)).not.toContain("payment_failed_order_open");
  });
});

describe("engine behaviour", () => {
  // The trap the seed plants: structurally identical to "paid but not
  // scheduled" except the payment has not captured and the order is new.
  // A reconciler that flags this is wrong.
  it("reports nothing for a freshly placed order still settling", () => {
    const s = snapshot({
      order: makeOrder({ status: "placed", createdAt: daysAgo(1) }),
      payment: makePayment({ status: "pending", paidAt: null }),
      delivery: makeDelivery({ status: "not_scheduled" }),
      events: [makeEvent("order_placed", daysAgo(1))],
    });
    expect(reconcileOrder(s, NOW)).toEqual([]);
  });

  it("sorts critical issues ahead of warnings", () => {
    // Delivered on a failed payment: critical (delivered_without_payment)
    // plus warning (payment_failed_order_open, since the order is still open).
    const s = snapshot({
      order: makeOrder({ status: "confirmed" }),
      payment: makePayment({ status: "failed", paidAt: null }),
      delivery: makeDelivery({
        status: "delivered",
        deliveredAt: daysAgo(1),
        scheduledDate: isoDate(daysAgo(9)),
      }),
    });
    const severities = reconcileOrder(s, NOW).map((i) => i.severity);
    expect(severities.length).toBeGreaterThan(1);
    expect(severities).toEqual([...severities].sort());
    expect(severities[0]).toBe("critical");
  });

  it("tolerates an order with no payment or delivery rows", () => {
    const s = snapshot({ payment: null, delivery: null });
    expect(() => reconcileOrder(s, NOW)).not.toThrow();
    expect(reconcileOrder(s, NOW)).toEqual([]);
  });

  it("is pure — repeated runs with the same clock agree", () => {
    const s = snapshot({
      payment: makePayment({ status: "paid", paidAt: daysAgo(30) }),
    });
    expect(reconcileOrder(s, NOW)).toEqual(reconcileOrder(s, NOW));
  });

  it("keeps RULE_IDS and RULES in sync", () => {
    expect(RULES.map((r) => r.id).sort()).toEqual([...RULE_IDS].sort());
  });
});
