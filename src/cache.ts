

export const DEFAULT_TTL_MS = Number(process.env.TOOL_CACHE_TTL_MS ?? 30_000);

type Entry = { value: unknown; expiresAt: number };

export class TtlCache {
  private store = new Map<string, Entry>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}


export function stableKey(toolName: string, args: unknown): string {
  return toolName + ":" + stringify(args);
}

function stringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stringify).join(",") + "]";

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ":" + stringify(v));

  return "{" + entries.join(",") + "}";
}
