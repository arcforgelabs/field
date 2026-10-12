-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Legacy item codes become aliases (#178, code retirement step 2).
-- An item is its uid. Every code that exists today is recorded here as an
-- alias of its item, so quote rows, json5 recipes and rules, and scripts that
-- name an item by code keep finding the same item. From here on an item's
-- code never changes (items_code_immutable) and every new item's code is
-- recorded as soon as the item exists (items_code_alias_insert).
CREATE TABLE "item_code_aliases" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"code" text NOT NULL,
	"item_uid" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "item_code_aliases_code_not_blank" CHECK (btrim("item_code_aliases"."code") <> '')
);
--> statement-breakpoint
ALTER TABLE "item_code_aliases" ADD CONSTRAINT "item_code_aliases_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_code_aliases" ADD CONSTRAINT "item_code_aliases_item_fk" FOREIGN KEY ("org_uid","item_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "item_code_aliases_org_code_lower_key" ON "item_code_aliases" USING btree ("org_uid",lower("code"));--> statement-breakpoint
CREATE INDEX "item_code_aliases_item_idx" ON "item_code_aliases" USING btree ("item_uid");--> statement-breakpoint
-- Backfill every current code, one organisation at a time: items has FORCE
-- ROW LEVEL SECURITY, so the owner sees an organisation's rows only with
-- field.org_uid set (a superuser sees all of them; the org_uid filter keeps
-- each pass to its own organisation either way).
DO $$
DECLARE
  org record;
  missing integer;
BEGIN
  FOR org IN SELECT uid FROM organizations ORDER BY uid LOOP
    PERFORM set_config('field.org_uid', org.uid, true);
    INSERT INTO "item_code_aliases" ("org_uid", "code", "item_uid", "created_at")
      SELECT "org_uid", "code", "uid", "created_at" FROM "items" WHERE "org_uid" = org.uid;
    SELECT count(*) INTO missing FROM "items" i
      WHERE i."org_uid" = org.uid
        AND NOT EXISTS (
          SELECT 1 FROM "item_code_aliases" a
          WHERE a."org_uid" = i."org_uid" AND a."item_uid" = i."uid" AND lower(a."code") = lower(i."code")
        );
    IF missing > 0 THEN
      RAISE EXCEPTION 'item_code_aliases backfill for % left % item code(s) without an alias', org.uid, missing;
    END IF;
  END LOOP;
  PERFORM set_config('field.org_uid', '', true);
END
$$;
--> statement-breakpoint
-- items.code is a legacy alias: recorded on insert, never changed after.
CREATE FUNCTION field_item_code_alias() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."code" IS DISTINCT FROM OLD."code" THEN
      RAISE EXCEPTION 'item % keeps its code %: item codes are legacy aliases and cannot change', OLD."uid", OLD."code"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO "item_code_aliases" ("org_uid", "code", "item_uid", "created_at")
    VALUES (NEW."org_uid", NEW."code", NEW."uid", NEW."created_at")
    ON CONFLICT ("org_uid", lower("code")) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM "item_code_aliases"
    WHERE "org_uid" = NEW."org_uid" AND lower("code") = lower(NEW."code") AND "item_uid" = NEW."uid"
  ) THEN
    RAISE EXCEPTION 'item code % is already an alias of another item', NEW."code"
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "items_code_alias_insert" AFTER INSERT ON "items" FOR EACH ROW EXECUTE FUNCTION field_item_code_alias();
--> statement-breakpoint
CREATE TRIGGER "items_code_immutable" BEFORE UPDATE OF "code" ON "items" FOR EACH ROW EXECUTE FUNCTION field_item_code_alias();
--> statement-breakpoint
ALTER TABLE "item_code_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "item_code_aliases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "item_code_aliases_tenant_isolation" ON "item_code_aliases" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
-- Requests may read and add aliases (a new item's trigger insert) and remove
-- them only with their item (the foreign key cascades). An alias is never
-- edited: it would repoint an old quote row at another item.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, DELETE ON "item_code_aliases" TO field_app;
  END IF;
END
$$;
