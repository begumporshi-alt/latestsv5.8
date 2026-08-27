-- Dry-run harness: apply the repair migration inside a transaction, print every
-- verification block, then roll back so production is untouched.
\set ON_ERROR_STOP on
BEGIN;
\i supabase/migrations/20260827001000_20260827_repair_item_level_cogs_and_period_accuracy.sql
\echo ''
\echo '######## DRY RUN COMPLETE - ROLLING BACK ########'
ROLLBACK;
