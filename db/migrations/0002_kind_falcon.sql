CREATE TABLE "query_history" (
	"query_id" uuid PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"answer" text NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
