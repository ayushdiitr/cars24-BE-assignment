import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "../db/client.ts";
import { answerQuery, MAX_ITERATIONS } from "../src/agent/orchestrator.ts";
import { LlmError } from "../src/llm/provider.ts";
import {
  MockProvider,
  callsTools,
  refuses,
  says,
} from "../src/llm/mock.ts";
import { clearToolCache } from "../src/tools/registry.ts";

const PAID_NOT_SCHEDULED = 4500;

beforeEach(() => clearToolCache());
afterAll(async () => {
  await sql.end();
});

describe("tool dispatch", () => {
  it("executes a requested tool and feeds the result back", async () => {
    const provider = new MockProvider([
      callsTools({
        id: "t1",
        name: "reconcile_order",
        arguments: { order_no: PAID_NOT_SCHEDULED },
      }),
      says("Order 4500 has a captured payment with no delivery scheduled."),
    ]);

    const result = await answerQuery("what is wrong with 4500?", provider);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe("reconcile_order");
    expect(result.answer).toContain("4500");
    expect(result.degraded).toBe(false);
    expect(result.iterations).toBe(2);

    // The second request must carry the tool result back to the model.
    const followUp = provider.requests[1]!;
    const resultsMessage = followUp.messages.find(
      (m) => m.role === "tool_results",
    );
    expect(resultsMessage).toBeDefined();
  });

  it("surfaces reconciliation issues as structured data, not just prose", async () => {
    const provider = new MockProvider([
      callsTools({
        id: "t1",
        name: "reconcile_order",
        arguments: { order_no: PAID_NOT_SCHEDULED },
      }),
      says("done"),
    ]);

    const result = await answerQuery("check 4500", provider);

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.map((i) => i.ruleId)).toContain(
      "payment_captured_delivery_not_scheduled",
    );
    // Evidence travels with the issue so the answer can be fact-checked.
    expect(result.issues[0]?.evidence).toBeDefined();
  });

  it("returns ALL parallel results in a single message", async () => {
    const provider = new MockProvider([
      callsTools(
        { id: "a", name: "get_payment_status", arguments: { order_no: 4500 } },
        { id: "b", name: "get_delivery_status", arguments: { order_no: 4500 } },
        { id: "c", name: "get_order_timeline", arguments: { order_no: 4500 } },
      ),
      says("summary"),
    ]);

    const result = await answerQuery("full picture on 4500", provider);
    expect(result.toolCalls).toHaveLength(3);

    const followUp = provider.requests[1]!;
    const resultMessages = followUp.messages.filter(
      (m) => m.role === "tool_results",
    );

    // Exactly one message holding three results — not three messages.
    expect(resultMessages).toHaveLength(1);
    expect(
      resultMessages[0]!.role === "tool_results" &&
        resultMessages[0]!.results,
    ).toHaveLength(3);
  });

  it("pairs each result with the tool call id that produced it", async () => {
    const provider = new MockProvider([
      callsTools(
        { id: "call-a", name: "get_payment_status", arguments: { order_no: 4500 } },
        { id: "call-b", name: "get_delivery_status", arguments: { order_no: 4500 } },
      ),
      says("ok"),
    ]);

    await answerQuery("q", provider);

    const message = provider.requests[1]!.messages.find(
      (m) => m.role === "tool_results",
    );
    if (message?.role !== "tool_results") throw new Error("expected results");

    expect(message.results.map((r) => r.toolCallId)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(message.results.map((r) => r.toolName)).toEqual([
      "get_payment_status",
      "get_delivery_status",
    ]);
  });
});

describe("error recovery", () => {
  it("recovers from invalid tool arguments instead of throwing", async () => {
    const provider = new MockProvider([
      callsTools({
        id: "bad",
        name: "get_order_status",
        arguments: { order_no: "four thousand" },
      }),
      // The model sees the validation error and corrects itself.
      callsTools({
        id: "good",
        name: "get_order_status",
        arguments: { order_no: PAID_NOT_SCHEDULED },
      }),
      says("Order 4500 is confirmed."),
    ]);

    const result = await answerQuery("status of 4500", provider);

    expect(result.toolCalls[0]?.result).toMatchObject({
      ok: false,
      reason: "invalid_arguments",
    });
    expect(result.toolCalls[1]?.result.ok).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it("recovers when the model invents a tool", async () => {
    const provider = new MockProvider([
      callsTools({ id: "x", name: "delete_everything", arguments: {} }),
      says("I can't do that, but here is what I can see."),
    ]);

    const result = await answerQuery("wipe the db", provider);
    expect(result.toolCalls[0]?.result.ok).toBe(false);
    expect(result.answer).toContain("can't");
  });

  it("marks a tool error on the message sent back to the model", async () => {
    const provider = new MockProvider([
      callsTools({
        id: "nf",
        name: "get_order_status",
        arguments: { order_no: 999999 },
      }),
      says("No such order."),
    ]);

    await answerQuery("status of 999999", provider);

    const message = provider.requests[1]!.messages.find(
      (m) => m.role === "tool_results",
    );
    if (message?.role !== "tool_results") throw new Error("expected results");
    expect(message.results[0]?.isError).toBe(true);
  });

  it("retries once on a retryable transport failure", async () => {
    const provider = new MockProvider([
      { throws: new LlmError("rate limited", true) },
      says("recovered"),
    ]);

    const result = await answerQuery("hello", provider);
    expect(result.answer).toBe("recovered");
    expect(result.degraded).toBe(false);
  });

  it("does not retry a non-retryable failure, and degrades instead of throwing", async () => {
    const provider = new MockProvider([
      { throws: new LlmError("bad api key", false) },
    ]);

    const result = await answerQuery("hello", provider);
    expect(result.degraded).toBe(true);
    expect(result.answer).toContain("bad api key");
    expect(provider.turnsUsed).toBe(1);
  });

  it("degrades when both attempts fail", async () => {
    const provider = new MockProvider([
      { throws: new LlmError("down", true) },
      { throws: new LlmError("still down", true) },
    ]);

    const result = await answerQuery("hello", provider);
    expect(result.degraded).toBe(true);
    expect(result.answer).toContain("couldn't complete");
  });

  it("stops on a refusal rather than retrying into it", async () => {
    const provider = new MockProvider([refuses("Declined for safety.")]);

    const result = await answerQuery("something disallowed", provider);
    expect(result.degraded).toBe(true);
    expect(result.answer).toBe("Declined for safety.");
    expect(provider.turnsUsed).toBe(1);
  });
});

describe("loop safety", () => {
  it("stops at the iteration cap and still returns the trace", async () => {
    // A model that never stops calling tools.
    const provider = new MockProvider(
      Array.from({ length: MAX_ITERATIONS + 2 }, (_, i) =>
        callsTools({
          id: "loop" + i,
          name: "get_order_status",
          arguments: { order_no: PAID_NOT_SCHEDULED },
        }),
      ),
    );

    const result = await answerQuery("spin forever", provider);

    expect(result.iterations).toBe(MAX_ITERATIONS);
    expect(result.degraded).toBe(true);
    expect(result.toolCalls).toHaveLength(MAX_ITERATIONS);
    expect(result.answer).toContain("narrower");
  });

  it("groups every tool call in one run under a single query id", async () => {
    const provider = new MockProvider([
      callsTools(
        { id: "a", name: "get_payment_status", arguments: { order_no: 4500 } },
        { id: "b", name: "get_delivery_status", arguments: { order_no: 4500 } },
      ),
      says("ok"),
    ]);

    const result = await answerQuery("q", provider);
    const { getQueryTrace } = await import("../src/repo/orders.ts");
    const trace = await getQueryTrace(result.queryId);

    expect(trace).toHaveLength(2);
    expect(new Set(trace.map((t) => t.queryId)).size).toBe(1);
  });
});

describe("provider contract", () => {
  it("sends the tool catalogue and a stable system prompt every turn", async () => {
    const provider = new MockProvider([
      callsTools({ id: "a", name: "get_order_status", arguments: { order_no: 4500 } }),
      says("ok"),
    ]);

    await answerQuery("q", provider);

    const [first, second] = provider.requests;
    // A varying system prompt would invalidate the cached prefix every turn.
    expect(first!.system).toBe(second!.system);
    expect(first!.tools.map((t) => t.name)).toEqual(
      second!.tools.map((t) => t.name),
    );
    expect(first!.tools.map((t) => t.name)).toContain("reconcile_fleet");

    for (const tool of first!.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
