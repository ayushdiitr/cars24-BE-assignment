import {
  LlmError,
  type CompletionRequest,
  type CompletionResponse,
  type LlmProvider,
} from "./provider.ts";

/**
 * Deterministic provider for tests.
 *
 * The orchestrator's behaviour — dispatching tools, batching results, handling
 * refusals, retrying transport failures, honouring the iteration cap — is all
 * testable without an API key or a cent of spend. Scripted turns are consumed
 * in order; a function turn can assert on what the loop actually sent.
 */

export type ScriptedTurn =
  | CompletionResponse
  | ((request: CompletionRequest, turnIndex: number) => CompletionResponse)
  | { throws: LlmError };

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "mock-model";

  /** Every request the loop made, for assertions. */
  readonly requests: CompletionRequest[] = [];
  private turn = 0;

  private script: ScriptedTurn[];

  constructor(script: ScriptedTurn[]) {
    this.script = script;
  }

  get turnsUsed(): number {
    return this.turn;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);

    const step = this.script[this.turn];
    this.turn++;

    if (!step) {
      throw new Error(
        "MockProvider ran out of scripted turns at turn " + this.turn +
          ". The loop made more calls than the test expected.",
      );
    }

    if (typeof step === "function") return step(request, this.turn - 1);
    if ("throws" in step) throw step.throws;
    return step;
  }
}

/** Convenience builders so tests read as intent, not as response literals. */
export const says = (text: string): CompletionResponse => ({
  stopReason: "end_turn",
  text,
  toolCalls: [],
});

export const callsTools = (
  ...calls: { id: string; name: string; arguments: unknown }[]
): CompletionResponse => ({
  stopReason: "tool_use",
  text: "",
  toolCalls: calls,
});

export const refuses = (text = "Declined."): CompletionResponse => ({
  stopReason: "refusal",
  text,
  toolCalls: [],
});
