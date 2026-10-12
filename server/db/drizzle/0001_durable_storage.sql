CREATE TABLE "field_blobs" (
	"sha256" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_files" (
	"path" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"mode" integer NOT NULL,
	"mtime" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_sqlite_images" (
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_sqlite_images_name_version_pk" PRIMARY KEY("name","version")
);
--> statement-breakpoint
ALTER TABLE "field_files" ADD CONSTRAINT "field_files_sha256_field_blobs_sha256_fk" FOREIGN KEY ("sha256") REFERENCES "public"."field_blobs"("sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_files_sha256_idx" ON "field_files" USING btree ("sha256");