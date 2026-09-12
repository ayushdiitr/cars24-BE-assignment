# Cars24 AI Operations Copilot

Backend service for operations teams investigating orders, payments, and deliveries. An ops user asks a natural-language question; the Anthropic model selects typed backend tools; the tools read PostgreSQL and return structured evidence; the model turns that evidence into a concise answer.

The LLM never receives database access and never writes SQL. Reconciliation is deterministic and can be called directly without an LLM.

This repository documents the backend only. The frontend is maintained separately.

## Stack

- Node.js 24+
- TypeScript with native Node ESM execution
- Fastify 5
- PostgreSQL 17
- Drizzle ORM and Drizzle Kit
- Zod tool/request validation
- Anthropic SDK, with `claude-sonnet-5` as the default model
- Vitest

## Prerequisites

Install Node.js 24 or later, npm, and Docker Desktop with Docker Compose support. The database is supplied by `docker-compose.yml`.

## Setup

From this directory:

```bash
npm install
Copy-Item .env.example .env
npm run db:up
npm run db:migrate
npm run db:seed
```

On macOS/Linux, use `cp .env.example .env` instead of `Copy-Item`.

Set `ANTHROPIC_API_KEY` in `.env` before using `POST /api/query`. The other endpoints, including direct order and reconciliation endpoints, work without an API key. The example file uses port `5000`; if `PORT` is omitted, the application defaults to `3000`.

Start the development server:

```bash
npm run dev
```

The server runs `index.ts` directly with Node's type stripping and watches for changes. For a compiled run:

```bash
npm run build
npm start
```

The build emits JavaScript under `dist/` and `npm start` builds before launching it.

## Database commands

```bash
npm run db:up          # Start PostgreSQL in Docker
npm run db:down        # Stop PostgreSQL
npm run db:migrate     # Apply checked-in migrations
npm run db:seed        # Destructive, deterministic reset and reseed
npm run db:studio      # Open Drizzle Studio
npm run db:generate    # Generate a migration after changing db/schema.ts
```

`db:seed` deletes existing order, payment, delivery, event, and tool-call data, then inserts 77 deterministic orders numbered `4500` through `4576`. It includes healthy examples and deliberately inconsistent scenarios such as paid-but-unscheduled, delivered-but-unpaid, cancelled-but-unrefunded, delayed-without-reschedule, overdue, and failed-payment orders.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. `.env.example` sets this to `5000`. |
| `DATABASE_URL` | none | PostgreSQL connection string. Required. |
| `ANTHROPIC_API_KEY` | none | Required only for `POST /api/query`. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Anthropic model name. |
| `LLM_PROVIDER` | `anthropic` | Provider selector. Anthropic is the intended deployment provider. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `PAID_NOT_SCHEDULED_GRACE_DAYS` | `3` | Grace period before the paid-but-unscheduled rule fires. |
| `AGENT_MAX_ITERATIONS` | `8` | Maximum model/tool loop iterations per query. |
| `TOOL_CACHE_TTL_MS` | `30000` | In-process successful tool-result cache TTL. |
| `RATE_LIMIT_BURST` | `10` | Initial token-bucket capacity per client IP. |
| `RATE_LIMIT_PER_MINUTE` | `20` | Token refill rate per client IP. |

Cost reporting is enabled when Anthropic rates are configured. Set `ANTHROPIC_INPUT_USD_PER_MILLION`, `ANTHROPIC_OUTPUT_USD_PER_MILLION`, and `ANTHROPIC_CACHE_READ_USD_PER_MILLION`, or model-specific equivalents such as `ANTHROPIC_CLAUDE_SONNET_5_INPUT_USD_PER_MILLION`. Unconfigured rates produce `null` cost values rather than fabricated costs.

## API

Set a shell variable for the running server, for example:

```bash
$base = "http://localhost:5000"
```

The examples below use `http://localhost:5000`. Use port `3000` when `PORT` is not set.

### `GET /health`

Checks database connectivity. No LLM call is made.

```bash
curl http://localhost:5000/health
```

Success:

```json
{"status":"ok","database":"connected"}
```

Returns `503` with `{"status":"error","database":"unreachable","error":"..."}` when the database check fails.

### `POST /api/query`

Runs the Anthropic-backed agent loop. The body must contain a `query` string with 1 to 2000 characters.

```bash
curl -X POST http://localhost:5000/api/query \
  -H "content-type: application/json" \
  -d '{"query":"Is order 4500 stuck?"}'
```

The response contains:

```json
{
  "queryId": "uuid",
  "answer": "...",
  "issues": [
    {
      "ruleId": "payment_captured_delivery_not_scheduled",
      "severity": "critical",
      "title": "Payment captured but delivery never scheduled",
      "detail": "...",
      "evidence": {"amount":"...","daysSincePaid":7}
    }
  ],
  "toolCalls": [
    {
      "tool":"reconcile_order",
      "arguments":{"order_no":4500},
      "durationMs":12,
      "cached":false,
      "ok":true,
      "result":{"ok":true,"data":{}}
    }
  ],
  "meta": {
    "iterations": 2,
    "degraded": false,
    "provider": "anthropic",
    "model": "claude-sonnet-5",
    "usage": {
      "attempts": 2,
      "inputTokens": 0,
      "outputTokens": 0,
      "cacheReadTokens": 0,
      "inputCostUsd": null,
      "outputCostUsd": null,
      "cacheReadCostUsd": null,
      "totalCostUsd": null
    }
  }
}
```

The tool trace is returned for transparency. `degraded` is true when the model refuses, transport retries are exhausted, or the iteration cap is reached. Rate limiting returns `429` with `error: "rate_limited"` and a `retry-after` header. Invalid input returns `400`; a missing Anthropic key returns `503`.

### Direct order and reconciliation endpoints

`GET /api/orders/:orderNo` returns the current `order`, `payment`, `delivery`, and chronological `events` snapshot.

```bash
curl http://localhost:5000/api/orders/4500
```

`GET /api/orders/:orderNo/reconcile` runs all deterministic rules without the LLM:

```bash
curl http://localhost:5000/api/orders/4500/reconcile
```

Response shape:

```json
{
  "order_no": 4500,
  "healthy": false,
  "issue_count": 1,
  "issues": [{"ruleId":"...","severity":"critical","title":"...","detail":"...","evidence":{}}]
}
```

Both endpoints return `400` for an invalid order number and `404` when no matching order exists.

### `GET /api/reconcile`

Scans every order without the LLM. Optionally filter by `severity=critical`, `warning`, or `info`.

```bash
curl "http://localhost:5000/api/reconcile?severity=critical"
```

Returns `orders_scanned`, `orders_with_issues`, `total_issues`, `counts_by_rule`, and the affected orders with their issues.

### Query history and observability

- `GET /api/queries?limit=30` lists recent saved queries. The limit is 1 to 100 and defaults to 30.
- `GET /api/queries/:queryId` returns a saved answer, issues, tool calls, metadata, and creation time.
- `GET /api/queries/:queryId/trace` replays tool calls and LLM attempts for a query, including durations, stop reasons, token counts, costs, and errors.
- `GET /api/costs` aggregates recorded LLM attempts, tokens, and known costs.

All query IDs are UUIDs. History and trace endpoints return `400` for malformed IDs and `404` when no matching records exist.

### `GET /`

Returns service metadata and the list of registered endpoints.

## Agent tools

The Anthropic model can call these typed tools. Every call is validated with Zod, optionally served from a short in-process TTL cache, executed through the repository layer, timed, and written to `tool_call_logs`.

| Tool | Arguments | Use |
| --- | --- | --- |
| `get_order_status` | `{ order_no: number }` | Core order status, customer, vehicle, and creation date. |
| `get_payment_status` | `{ order_no: number }` | Payment status, amount, and capture time. |
| `get_delivery_status` | `{ order_no: number }` | Delivery status, scheduled date, and delivery time. |
| `get_order_timeline` | `{ order_no: number }` | Chronological append-only event history. |
| `reconcile_order` | `{ order_no: number }` | All consistency checks for one order, with evidence. |
| `search_orders` | Status arrays, date bounds, `has_issue`, and `limit` | Search groups of orders; results are capped. |
| `reconcile_fleet` | Optional `severity`, `limit_per_rule` | Fleet-wide issue counts and example order numbers. |

Unknown tools, invalid arguments, missing orders, and execution failures are returned as structured tool results so the model can recover rather than receiving an uncaught exception.

## Reconciliation rules

The pure rule engine evaluates an `OrderSnapshot` at an injected time and sorts issues by severity (`critical`, then `warning`, then `info`). Current rules are:

- `payment_captured_delivery_not_scheduled` (`critical`): paid more than `PAID_NOT_SCHEDULED_GRACE_DAYS` ago while delivery remains `not_scheduled`; cancelled orders are excluded.
- `delivered_without_payment` (`critical`): delivery is `delivered` while payment is not `paid`.
- `refund_pending_on_cancelled_order` (`critical`): cancelled order remains paid with no refund event.
- `delivery_overdue` (`warning`): scheduled date is before today and delivery is not complete.
- `delayed_without_reschedule` (`warning`): delivery is delayed with no new scheduled date.
- `payment_failed_order_open` (`warning`): payment failed while the order remains `placed` or `confirmed`.

## Development and testing

```bash
npm run typecheck
npm test
npx vitest run tests/rules.test.ts
npx vitest run tests/tools.test.ts
npx vitest run tests/orchestrator.test.ts
npm run build
```

The rules tests are pure and need no database. Tool and orchestrator tests use the seeded PostgreSQL database; run `db:up`, `db:migrate`, and `db:seed` first. The orchestrator uses `MockProvider`, so tests do not spend Anthropic API credits or require an API key.

## Project layout

- `index.ts`: server bootstrap and lazy provider selection.
- `src/api`: HTTP routes and request validation.
- `src/agent`: Anthropic-independent agent loop and system prompt.
- `src/llm`: provider interface, Anthropic adapter, fallback OpenAI adapter, mock provider, and pricing.
- `src/tools`: tool definitions and the `runTool()` registry chokepoint.
- `src/reconcile`: pure business rules and issue types.
- `src/repo`: all SQL access and query observability persistence.
- `db`: Drizzle schema, migrations, client, and seed data.
- `tests`: rule, tool, and orchestrator coverage.

See [DESIGN.md](DESIGN.md) for the architectural decisions and trade-offs.
