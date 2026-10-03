-- Tighten RLS on customers and payments (phase 2 of the RLS lockdown).
--
-- Same rationale as 20261003120000: migration 20260702175411 granted anon
-- full CRUD everywhere; these two tables hold the customer list (names,
-- phones, addresses, outstanding balances) and the payment ledger. Logged-in
-- users keep full access; offline sync RPCs are SECURITY DEFINER and bypass
-- RLS, so offline payment collection still syncs.
-- NOT touched in this phase: journal_entries, journal_lines, app_settings and
-- the remaining tables from 20260702175411 — pending separate review.

DROP POLICY IF EXISTS cust_select ON customers;
DROP POLICY IF EXISTS cust_insert ON customers;
DROP POLICY IF EXISTS cust_update ON customers;
DROP POLICY IF EXISTS cust_delete ON customers;

CREATE POLICY cust_select ON customers FOR SELECT TO authenticated USING (true);
CREATE POLICY cust_insert ON customers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY cust_update ON customers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cust_delete ON customers FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS pay_select ON payments;
DROP POLICY IF EXISTS pay_insert ON payments;
DROP POLICY IF EXISTS pay_update ON payments;
DROP POLICY IF EXISTS pay_delete ON payments;

CREATE POLICY pay_select ON payments FOR SELECT TO authenticated USING (true);
CREATE POLICY pay_insert ON payments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY pay_update ON payments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY pay_delete ON payments FOR DELETE TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
