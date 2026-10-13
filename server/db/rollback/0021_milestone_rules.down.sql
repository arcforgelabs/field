-- Reverses migration 0021_milestone_rules for an emergency rollback to a
-- release from before it. Run it before 0020's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0021_milestone_rules.down.sql
--
-- The rules go with it: after 0021 is applied again, the organisation has no
-- milestone rules until an owner enters them in Settings. Jobs keep the
-- schedules they already have, and issued invoices keep the cap alerts
-- recorded with them (they live in the job's files and issued documents).

SET LOCAL lock_timeout = '10s';

DROP TABLE "milestone_rule_caps";
DROP TABLE "milestone_rule_milestones";
DROP TABLE "milestone_rules";
ALTER TABLE "business_settings" DROP CONSTRAINT "business_settings_region_check";
ALTER TABLE "business_settings" DROP CONSTRAINT "business_settings_country_check";
ALTER TABLE "business_settings" DROP COLUMN "region";
ALTER TABLE "business_settings" DROP COLUMN "country";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791898979487;
