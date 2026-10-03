-- Tighten RLS on sales documents: invoices, invoice_items, quotations,
-- quotation_items.
--
-- Migration 20260702175411_all_rls_policy.sql granted anon + authenticated
-- full CRUD on every table while the app was a demo. The app now has real
-- logins, and the public share-link feature promises that only people with
-- the token can see a document — which anon table access defeats.
--
-- This migration removes ANON access to just these four sales tables.
-- Authenticated users keep full access (USING/WITH CHECK true), matching the
-- original business-operations policies. The offline-sync RPCs are SECURITY
-- DEFINER and bypass RLS, so queued offline writes are unaffected. The
-- public share page reads through get_shared_document() (token-scoped), so
-- it keeps working.
--
-- Nothing else is changed here; other tables remain as 20260702175411 left
-- them until they are reviewed separately.

DROP POLICY IF EXISTS invoice_select ON invoices;
DROP POLICY IF EXISTS invoice_insert ON invoices;
DROP POLICY IF EXISTS invoice_update ON invoices;
DROP POLICY IF EXISTS invoice_delete ON invoices;

CREATE POLICY invoice_select ON invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY invoice_insert ON invoices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY invoice_update ON invoices FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY invoice_delete ON invoices FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS inv_item_select ON invoice_items;
DROP POLICY IF EXISTS inv_item_insert ON invoice_items;
DROP POLICY IF EXISTS inv_item_update ON invoice_items;
DROP POLICY IF EXISTS inv_item_delete ON invoice_items;

CREATE POLICY inv_item_select ON invoice_items FOR SELECT TO authenticated USING (true);
CREATE POLICY inv_item_insert ON invoice_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY inv_item_update ON invoice_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY inv_item_delete ON invoice_items FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS quote_select ON quotations;
DROP POLICY IF EXISTS quote_insert ON quotations;
DROP POLICY IF EXISTS quote_update ON quotations;
DROP POLICY IF EXISTS quote_delete ON quotations;

CREATE POLICY quote_select ON quotations FOR SELECT TO authenticated USING (true);
CREATE POLICY quote_insert ON quotations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY quote_update ON quotations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY quote_delete ON quotations FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS qi_select ON quotation_items;
DROP POLICY IF EXISTS qi_insert ON quotation_items;
DROP POLICY IF EXISTS qi_update ON quotation_items;
DROP POLICY IF EXISTS qi_delete ON quotation_items;

CREATE POLICY qi_select ON quotation_items FOR SELECT TO authenticated USING (true);
CREATE POLICY qi_insert ON quotation_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY qi_update ON quotation_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY qi_delete ON quotation_items FOR DELETE TO authenticated USING (true);
