import fastify from "fastify";
import "dotenv/config";
import { registerRoutes } from "./src/api/routes.ts";
import { AnthropicProvider } from "./src/llm/anthropic.ts";
import { OpenAiProvider } from "./src/llm/openai.ts";
import type { LlmProvider } from "./src/llm/provider.ts";

const server = fastify({ logger: {
    level: process.env.LOG_LEVEL ?? "info",
    transport: { target: "pino-pretty" },
    redact: ["req.headers.authorization"],
} });
const port = Number(process.env.PORT) || 3000;


let provider: LlmProvider | null = null;

function getProvider(): LlmProvider {
  if (provider) return provider;

  const configured = process.env.LLM_PROVIDER ?? "anthropic";

  if (configured === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set.");
    }
    provider = new OpenAiProvider();
    return provider;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }
  provider = new AnthropicProvider();
  return provider;
}

await registerRoutes(server, { getProvider });

server.get("/", async () => ({
  service: "cars24-ops-copilot",
  endpoints: [
    "POST /api/query",
    "GET  /api/orders/:orderNo",
    "GET  /api/orders/:orderNo/reconcile",
    "GET  /api/reconcile",
    "GET  /api/queries",
    "GET  /api/queries/:queryId",
    "GET  /api/queries/:queryId/trace",
    "GET  /api/costs",
    "GET  /health",
  ],
}));

server.listen({ port }, (err, address) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
  server.log.info("Ops copilot listening at " + address);
});
