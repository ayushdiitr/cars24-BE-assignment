import {
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const orderStatus = pgEnum("order_status", [
  "placed",
  "confirmed",
  "cancelled",
  "completed",
]);

export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "paid",
  "failed",
  "refunded",
]);

export const deliveryStatus = pgEnum("delivery_status", [
  "not_scheduled",
  "scheduled",
  "out_for_delivery",
  "delivered",
  "delayed",
]);

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Human-facing identifier ops staff and the LLM actually use ("order #4521").
  // Kept separate from the uuid pk so public IDs don't leak row counts.
  orderNo: integer("order_no").notNull().unique(),
  customerId: uuid("customer_id").notNull(),
  vehicleId: uuid("vehicle_id").notNull(),
  status: orderStatus("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  status: paymentStatus("status").notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export const deliveries = pgTable("deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  status: deliveryStatus("status").notNull(),
  scheduledDate: date("scheduled_date"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});


export const orderEvents = pgTable("order_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});


export const toolCallLogs = pgTable("tool_call_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  queryId: uuid("query_id").notNull(),
  toolName: text("tool_name").notNull(),
  arguments: jsonb("arguments").notNull(),
  result: jsonb("result"),
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const queryLogs = pgTable("query_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  queryId: uuid("query_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  attempt: integer("attempt").notNull(),
  iteration: integer("iteration").notNull(),
  status: text("status").notNull(),
  stopReason: text("stop_reason"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  inputCostUsd: numeric("input_cost_usd", { precision: 20, scale: 12 }),
  outputCostUsd: numeric("output_cost_usd", { precision: 20, scale: 12 }),
  cacheReadCostUsd: numeric("cache_read_cost_usd", {
    precision: 20,
    scale: 12,
  }),
  totalCostUsd: numeric("total_cost_usd", { precision: 20, scale: 12 }),
  durationMs: integer("duration_ms").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const queryHistory = pgTable("query_history", {
  queryId: uuid("query_id").primaryKey(),
  query: text("query").notNull(),
  answer: text("answer").notNull(),
  issues: jsonb("issues").notNull().default([]),
  toolCalls: jsonb("tool_calls").notNull().default([]),
  meta: jsonb("meta").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Order = typeof orders.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type ToolCallLog = typeof toolCallLogs.$inferSelect;
export type QueryLog = typeof queryLogs.$inferSelect;
export type QueryHistory = typeof queryHistory.$inferSelect;
