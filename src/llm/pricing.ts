import type { CompletionResponse } from "./provider.ts";

type Usage = NonNullable<CompletionResponse["usage"]>;

export type AttemptCost = {
  inputCostUsd: string | null;
  outputCostUsd: string | null;
  cacheReadCostUsd: string | null;
  totalCostUsd: string | null;
};

type Pricing = {
  input: string | undefined;
  output: string | undefined;
  cacheRead: string | undefined;
};

const MICRODOLLARS_PER_MILLION = 1_000_000n;
const COST_SCALE = 6;

function pricingFor(provider: string, model: string): Pricing {
  const prefix = provider.toUpperCase();
  const modelKey = model.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    input:
      process.env[`${prefix}_${modelKey}_INPUT_USD_PER_MILLION`] ??
      process.env[`${prefix}_INPUT_USD_PER_MILLION`],
    output:
      process.env[`${prefix}_${modelKey}_OUTPUT_USD_PER_MILLION`] ??
      process.env[`${prefix}_OUTPUT_USD_PER_MILLION`],
    cacheRead:
      process.env[`${prefix}_${modelKey}_CACHE_READ_USD_PER_MILLION`] ??
      process.env[`${prefix}_CACHE_READ_USD_PER_MILLION`],
  };
}

function parseRate(rate: string | undefined): bigint | null {
  if (!rate || !/^\d+(\.\d{1,6})?$/.test(rate)) return null;
  const [whole, fraction = ""] = rate.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function costFor(tokens: number | undefined, rate: string | undefined): string | null {
  const parsedRate = parseRate(rate);
  if (tokens === 0 && rate === undefined) return "0.000000";
  if (tokens === undefined || parsedRate === null) return null;

  const microdollars =
    (BigInt(tokens) * parsedRate) / MICRODOLLARS_PER_MILLION;
  return formatUsd(microdollars);
}

function formatUsd(microdollars: bigint): string {
  const whole = microdollars / 1_000_000n;
  const fraction = (microdollars % 1_000_000n)
    .toString()
    .padStart(COST_SCALE, "0");
  return `${whole}.${fraction}`;
}

export function costForUsage(
  provider: string,
  model: string,
  usage: Usage | undefined,
): AttemptCost {
  if (!usage) {
    return {
      inputCostUsd: null,
      outputCostUsd: null,
      cacheReadCostUsd: null,
      totalCostUsd: null,
    };
  }

  const pricing = pricingFor(provider, model);
  const inputCostUsd = costFor(usage.inputTokens, pricing.input);
  const outputCostUsd = costFor(usage.outputTokens, pricing.output);
  const cacheReadCostUsd = costFor(
    usage.cacheReadTokens ?? 0,
    pricing.cacheRead,
  );

  return {
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    totalCostUsd:
      inputCostUsd !== null && outputCostUsd !== null && cacheReadCostUsd !== null
        ? addUsd(addUsd(inputCostUsd, outputCostUsd), cacheReadCostUsd)
        : null,
  };
}

export function addUsd(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return null;
  const toMicrodollars = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  };
  return formatUsd(toMicrodollars(left) + toMicrodollars(right));
}