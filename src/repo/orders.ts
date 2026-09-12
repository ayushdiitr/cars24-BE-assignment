import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../../db/client.ts";
import {
  deliveries,
  orderEvents,
  orders,
  payments,
  toolCallLogs,
  type Delivery,
  type Order,
  type OrderEvent,
  type Payment,
} from "../../db/schema.ts";
import type { OrderSnapshot } from "../reconcile/types.ts";



export type OrderFilters = {
  orderStatus?: Order["status"][] | undefined;
  paymentStatus?: Payment["status"][] | undefined;
  deliveryStatus?: Delivery["status"][] | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  scheduledAfter?: string | undefined;
  scheduledBefore?: string | undefined;
  limit?: number | undefined;
};

type JoinedRow = {
  order: Order;
  payment: Payment | null;
  delivery: Delivery | null;
};

const baseQuery = () =>
  db
    .select({ order: orders, payment: payments, delivery: deliveries })
    .from(orders)
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .leftJoin(deliveries, eq(deliveries.orderId, orders.id));

async function attachEvents(rows: JoinedRow[]): Promise<OrderSnapshot[]> {
  if (rows.length === 0) return [];

  const orderIds = rows.map((r) => r.order.id);
  const events = await db
    .select()
    .from(orderEvents)
    .where(inArray(orderEvents.orderId, orderIds))
    .orderBy(asc(orderEvents.createdAt));

  const byOrder = new Map<string, OrderEvent[]>();
  for (const event of events) {
    const list = byOrder.get(event.orderId);
    if (list) list.push(event);
    else byOrder.set(event.orderId, [event]);
  }

  return rows.map((row) => ({
    order: row.order,
    payment: row.payment,
    delivery: row.delivery,
    events: byOrder.get(row.order.id) ?? [],
  }));
}

export async function getSnapshot(
  orderNo: number,
): Promise<OrderSnapshot | null> {
  const rows = await baseQuery().where(eq(orders.orderNo, orderNo)).limit(1);
  const row = rows[0];
  if (!row) return null;

  const [snapshot] = await attachEvents([row]);
  return snapshot ?? null;
}


export async function getAllSnapshots(): Promise<OrderSnapshot[]> {
  const rows = await baseQuery().orderBy(asc(orders.orderNo));
  return attachEvents(rows);
}

export async function searchOrders(
  filters: OrderFilters,
): Promise<OrderSnapshot[]> {
  const limit = Math.min(filters.limit ?? 20, 100);
  const conditions = [];

  if (filters.orderStatus?.length) {
    conditions.push(inArray(orders.status, filters.orderStatus));
  }
  if (filters.paymentStatus?.length) {
    conditions.push(inArray(payments.status, filters.paymentStatus));
  }
  if (filters.deliveryStatus?.length) {
    conditions.push(inArray(deliveries.status, filters.deliveryStatus));
  }
  if (filters.createdAfter) {
    conditions.push(gte(orders.createdAt, new Date(filters.createdAfter)));
  }
  if (filters.createdBefore) {
    conditions.push(lte(orders.createdAt, new Date(filters.createdBefore)));
  }
  if (filters.scheduledAfter) {
    conditions.push(gte(deliveries.scheduledDate, filters.scheduledAfter));
  }
  if (filters.scheduledBefore) {
    conditions.push(lte(deliveries.scheduledDate, filters.scheduledBefore));
  }

  const rows = await baseQuery()
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(orders.orderNo))
    .limit(limit);

  return attachEvents(rows);
}

export async function getQueryTrace(queryId: string) {
  return db
    .select()
    .from(toolCallLogs)
    .where(eq(toolCallLogs.queryId, queryId))
    .orderBy(asc(toolCallLogs.createdAt));
}
