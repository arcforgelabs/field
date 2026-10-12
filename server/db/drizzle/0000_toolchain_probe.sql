CREATE TABLE "drizzle_toolchain_probe" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drizzle_toolchain_probe_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"probe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
