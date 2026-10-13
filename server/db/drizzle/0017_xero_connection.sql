-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- The Xero connection (#93, phase 1): one row per organisation, none meaning
-- not connected. It holds the chosen Xero organisation, the OAuth tokens
-- encrypted with AES-256-GCM (server/xero/token-crypto.js), the sign-in in
-- progress (its state only as a SHA-256) and the owner's settings: what Field
-- creates in Xero, the sales account code and the GST tax type. The Xero
-- app's client id and secret are deployment secrets and never stored.
-- Additive. Then FORCE ROW LEVEL SECURITY and field_app's grants, which
-- drizzle-kit does not emit.
CREATE TABLE "xero_connections" (
	"org_uid" text PRIMARY KEY DEFAULT field_org_uid() NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"tenant_id" text,
	"tenant_name" text,
	"connection_id" text,
	"available_tenants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"access_expires_at" timestamp with time zone,
	"refresh_issued_at" timestamp with time zone,
	"key_fingerprint" text,
	"reconnect_reason" text,
	"pending_state_hash" text,
	"pending_by" text,
	"pending_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"connected_by" text,
	"create_mode" text DEFAULT 'draft' NOT NULL,
	"invoice_numbering" text DEFAULT 'field' NOT NULL,
	"sales_account_code" text DEFAULT '200' NOT NULL,
	"tax_type" text DEFAULT 'OUTPUT' NOT NULL,
	"auto_from" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "xero_connections_status_check" CHECK ("xero_connections"."status" in ('disconnected','choose_organisation','connected','needs_reconnect')),
	CONSTRAINT "xero_connections_create_mode_check" CHECK ("xero_connections"."create_mode" in ('off','draft','authorised')),
	CONSTRAINT "xero_connections_invoice_numbering_check" CHECK ("xero_connections"."invoice_numbering" in ('field')),
	CONSTRAINT "xero_connections_connected_check" CHECK ("xero_connections"."status" <> 'connected' or ("xero_connections"."tenant_id" is not null and "xero_connections"."refresh_token_enc" is not null)),
	CONSTRAINT "xero_connections_account_code_check" CHECK ("xero_connections"."sales_account_code" ~ '^[A-Za-z0-9._-]{1,10}$'),
	CONSTRAINT "xero_connections_tax_type_check" CHECK ("xero_connections"."tax_type" ~ '^[A-Z0-9_]{1,40}$'),
	CONSTRAINT "xero_connections_reconnect_reason_check" CHECK ("xero_connections"."reconnect_reason" is null or "xero_connections"."reconnect_reason" ~ '^[A-Z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "xero_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "xero_connections" ADD CONSTRAINT "xero_connections_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "xero_connections_tenant_isolation" ON "xero_connections" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "xero_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "xero_connections" TO field_app;
  END IF;
END
$$;
