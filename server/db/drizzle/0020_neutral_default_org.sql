-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- A new installation's default organisation has a neutral name (#122).
-- Data only. 0005_tenancy seeded the default organisation (DEFAULT_ORG_UID)
-- with the name and slug of the business Field was built for; applied
-- migrations never change, so this renames it instead, and only on a
-- database nobody has used yet: no person exists (`users` is not a tenant
-- table, and every membership names a person). An installation that already
-- has people keeps its organisation's name and slug. Without FIELD_ORG the
-- deployment resolves the default organisation by uid, not slug
-- (server/db-runtime/tenancy.js), so both kinds boot the same way.
UPDATE "organizations"
SET "name" = 'Default organisation', "slug" = 'default', "updated_at" = now()
WHERE "uid" = 'org_01M4NF6NV3HW3CCZB7NVB9B157'
  AND "slug" = 'embark'
  AND NOT EXISTS (SELECT 1 FROM "users")
  AND NOT EXISTS (SELECT 1 FROM "organizations" WHERE "slug" = 'default');
