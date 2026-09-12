import { randomUUID } from "node:crypto";
import { db, sql } from "./client.ts";
import {
  deliveries,
  orderEvents,
  orders,
  payments,
  toolCallLogs,
} from "./schema.ts";

// Deterministic PRNG so reruns produce identical data — a reviewer running the
// seed should see the same orders the README's example queries reference.
function makeRng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const rng = makeRng(42);

const pick = <T>(items: readonly T[]): T => {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick() from empty array");
  return item;
};

const randInt = (min: number, max: number) =>
  min + Math.floor(rng() * (max - min + 1));

const NOW = new Date("2026-09-12T10:00:00Z");

const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const daysFromNow = (days: number) =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const money = (min: number, max: number) => (randInt(min, max) * 1000).toFixed(2);

type Scenario =
  | "happy_delivered"
  | "happy_scheduled"
  | "paid_not_scheduled"
  | "delivered_unpaid"
  | "cancelled_unrefunded"
  | "delayed_no_reschedule"
  | "overdue_delivery"
  | "payment_failed"
  | "fresh_order";

type EventSeed = { type: string; payload: Record<string, unknown>; at: Date };

type Built = {
  order: typeof orders.$inferInsert;
  payment: typeof payments.$inferInsert;
  delivery: typeof deliveries.$inferInsert;
  events: (typeof orderEvents.$inferInsert)[];
};

function build(orderNo: number, scenario: Scenario): Built {
  const orderId = randomUUID();
  const placedDaysAgo = randInt(5, 60);
  const placedAt = daysAgo(placedDaysAgo);
  const amount = money(180, 1400);

  const events: EventSeed[] = [
    { type: "order_placed", payload: { orderNo }, at: placedAt },
  ];

  let order: typeof orders.$inferInsert = {
    id: orderId,
    orderNo,
    customerId: randomUUID(),
    vehicleId: randomUUID(),
    status: "confirmed",
    createdAt: placedAt,
  };

  let payment: typeof payments.$inferInsert = {
    orderId,
    amount,
    status: "paid",
    paidAt: daysAgo(placedDaysAgo - 1),
  };

  let delivery: typeof deliveries.$inferInsert = {
    orderId,
    status: "not_scheduled",
    scheduledDate: null,
    deliveredAt: null,
  };

  switch (scenario) {
    // ---- Happy paths (the "noise" so demo queries aren't cherry-picked) ----
    case "happy_delivered": {
      const paidAt = daysAgo(placedDaysAgo - 1);
      const deliveredAt = daysAgo(Math.max(1, placedDaysAgo - 5));
      order = { ...order, status: "completed" };
      payment = { ...payment, status: "paid", paidAt };
      delivery = {
        ...delivery,
        status: "delivered",
        scheduledDate: isoDate(daysAgo(Math.max(2, placedDaysAgo - 6))),
        deliveredAt,
      };
      events.push(
        { type: "payment_captured", payload: { amount }, at: paidAt },
        {
          type: "delivery_scheduled",
          payload: { scheduledDate: isoDate(daysAgo(placedDaysAgo - 6)) },
          at: daysAgo(placedDaysAgo - 3),
        },
        { type: "delivery_completed", payload: {}, at: deliveredAt },
      );
      break;
    }

    case "happy_scheduled": {
      const paidAt = daysAgo(placedDaysAgo - 1);
      const scheduled = daysFromNow(randInt(2, 10));
      payment = { ...payment, status: "paid", paidAt };
      delivery = {
        ...delivery,
        status: "scheduled",
        scheduledDate: isoDate(scheduled),
      };
      events.push(
        { type: "payment_captured", payload: { amount }, at: paidAt },
        {
          type: "delivery_scheduled",
          payload: { scheduledDate: isoDate(scheduled) },
          at: daysAgo(placedDaysAgo - 2),
        },
      );
      break;
    }

    case "fresh_order": {
      // Placed today-ish, payment still settling. Legitimately inconsistent —
      // the reconciler must NOT flag this, which is what makes the N-day
      // threshold on paid-but-not-scheduled meaningful.
      const recent = daysAgo(randInt(0, 1));
      order = { ...order, status: "placed", createdAt: recent };
      payment = { ...payment, status: "pending", paidAt: null };
      delivery = { ...delivery, status: "not_scheduled" };
      events[0] = { type: "order_placed", payload: { orderNo }, at: recent };
      events.push({
        type: "payment_initiated",
        payload: { amount },
        at: recent,
      });
      break;
    }

    // ---- Edge cases the reconciliation engine must catch ----
    case "paid_not_scheduled": {
      // The example query from the brief: money captured, nothing scheduled,
      // and enough time has passed that it's clearly stuck.
      const paidAt = daysAgo(placedDaysAgo - 1);
      payment = { ...payment, status: "paid", paidAt };
      delivery = { ...delivery, status: "not_scheduled" };
      events.push({
        type: "payment_captured",
        payload: { amount },
        at: paidAt,
      });
      break;
    }

    case "delivered_unpaid": {
      const deliveredAt = daysAgo(randInt(1, 10));
      order = { ...order, status: "completed" };
      payment = { ...payment, status: "pending", paidAt: null };
      delivery = {
        ...delivery,
        status: "delivered",
        scheduledDate: isoDate(daysAgo(randInt(11, 14))),
        deliveredAt,
      };
      events.push(
        { type: "payment_initiated", payload: { amount }, at: placedAt },
        { type: "delivery_completed", payload: {}, at: deliveredAt },
      );
      break;
    }

    case "cancelled_unrefunded": {
      const paidAt = daysAgo(placedDaysAgo - 1);
      const cancelledAt = daysAgo(Math.max(1, placedDaysAgo - 4));
      order = { ...order, status: "cancelled" };
      // Note: no refund event and status stays "paid" — that gap is the bug
      // the reconciler reports.
      payment = { ...payment, status: "paid", paidAt };
      delivery = { ...delivery, status: "not_scheduled" };
      events.push(
        { type: "payment_captured", payload: { amount }, at: paidAt },
        {
          type: "order_cancelled",
          payload: { reason: pick(["customer_request", "vehicle_unavailable"]) },
          at: cancelledAt,
        },
      );
      break;
    }

    case "delayed_no_reschedule": {
      const paidAt = daysAgo(placedDaysAgo - 1);
      const originalDate = daysAgo(randInt(3, 12));
      payment = { ...payment, status: "paid", paidAt };
      // Marked delayed but scheduledDate was cleared and never replaced.
      delivery = { ...delivery, status: "delayed", scheduledDate: null };
      events.push(
        { type: "payment_captured", payload: { amount }, at: paidAt },
        {
          type: "delivery_scheduled",
          payload: { scheduledDate: isoDate(originalDate) },
          at: daysAgo(placedDaysAgo - 2),
        },
        {
          type: "delivery_delayed",
          payload: {
            reason: pick(["transport_breakdown", "rto_paperwork", "weather"]),
          },
          at: originalDate,
        },
      );
      break;
    }

    case "overdue_delivery": {
      const paidAt = daysAgo(placedDaysAgo - 1);
      const scheduled = daysAgo(randInt(2, 9));
      payment = { ...payment, status: "paid", paidAt };
      // Scheduled date is in the past but status never advanced — SLA breach.
      delivery = {
        ...delivery,
        status: "scheduled",
        scheduledDate: isoDate(scheduled),
      };
      events.push(
        { type: "payment_captured", payload: { amount }, at: paidAt },
        {
          type: "delivery_scheduled",
          payload: { scheduledDate: isoDate(scheduled) },
          at: daysAgo(placedDaysAgo - 2),
        },
      );
      break;
    }

    case "payment_failed": {
      order = { ...order, status: "placed" };
      payment = { ...payment, status: "failed", paidAt: null };
      delivery = { ...delivery, status: "not_scheduled" };
      events.push({
        type: "payment_failed",
        payload: { reason: pick(["insufficient_funds", "bank_declined"]) },
        at: daysAgo(placedDaysAgo - 1),
      });
      break;
    }
  }

  return {
    order,
    payment,
    delivery,
    events: events
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((e) => ({
        orderId,
        eventType: e.type,
        payload: e.payload,
        createdAt: e.at,
      })),
  };
}

// Mix: enough happy-path noise that the broken orders have to be found, not
// stumbled into, but every edge case appears several times so rules can be
// exercised against more than a single row.
const PLAN: [Scenario, number][] = [
  ["happy_delivered", 22],
  ["happy_scheduled", 16],
  ["fresh_order", 8],
  ["paid_not_scheduled", 7],
  ["delivered_unpaid", 4],
  ["cancelled_unrefunded", 5],
  ["delayed_no_reschedule", 5],
  ["overdue_delivery", 6],
  ["payment_failed", 4],
];

async function seed() {
  console.log("Clearing existing data...");
  // Children first; orders cascade but being explicit keeps this readable.
  await db.delete(toolCallLogs);
  await db.delete(orderEvents);
  await db.delete(payments);
  await db.delete(deliveries);
  await db.delete(orders);

  const scenarios: Scenario[] = [];
  for (const [scenario, count] of PLAN) {
    for (let i = 0; i < count; i++) scenarios.push(scenario);
  }

  // Shuffle so order numbers don't cluster by scenario — otherwise "#4521-4527
  // are all broken" makes the demo look staged.
  for (let i = scenarios.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = scenarios[i]!;
    const b = scenarios[j]!;
    scenarios[i] = b;
    scenarios[j] = a;
  }

  const built = scenarios.map((scenario, i) => build(4500 + i, scenario));

  await db.insert(orders).values(built.map((b) => b.order));
  await db.insert(payments).values(built.map((b) => b.payment));
  await db.insert(deliveries).values(built.map((b) => b.delivery));
  await db.insert(orderEvents).values(built.flatMap((b) => b.events));

  const counts = new Map<Scenario, number[]>();
  scenarios.forEach((s, i) => {
    const list = counts.get(s) ?? [];
    list.push(4500 + i);
    counts.set(s, list);
  });

  console.log(`\nSeeded ${built.length} orders (#4500-#${4500 + built.length - 1}):\n`);
  for (const [scenario, count] of PLAN) {
    const nos = counts.get(scenario) ?? [];
    const sample = nos.slice(0, 3).map((n) => `#${n}`).join(", ");
    console.log(`  ${scenario.padEnd(24)} ${String(count).padStart(2)}  e.g. ${sample}`);
  }
  console.log();
}

seed()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
