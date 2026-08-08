-- ============================================================
-- Migration 020: super_admin RLS — narrow and additive
-- ============================================================
-- super_admin is deliberately NOT a blanket cross-college bypass. Its scope
-- is platform provisioning only (create colleges, invite each college's
-- first Admin, oversee invitations) — no visibility into academic/financial
-- data (students, fees, attendance, etc.) in any tenant. If that ever needs
-- to change, it's a separate, much larger RLS audit across every table with
-- a college_id = get_my_college_id() policy, not an extension of this file.
--
-- Every policy below is additive — Postgres RLS unions permissive policies,
-- so none of this narrows or touches any existing role's access on these
-- tables.
--
-- super_admin is also NOT implicitly `admin`: requireRole(["admin"]) in
-- every existing Server Action continues to reject super_admin by design
-- (see lib/rbac.ts) — that boundary is enforced at the app layer, this
-- migration only covers what RLS itself needs to allow.

-- colleges: currently has a SELECT policy (006_rls_policies.sql) and an
-- UPDATE policy scoped to the caller's own college (016_colleges_admin.sql)
-- — but no INSERT policy at all until now, since nothing has ever created a
-- college through the app.
CREATE POLICY "colleges_super_admin_all" ON public.colleges
  FOR ALL USING (public.get_my_role() = 'super_admin');

CREATE POLICY "colleges_super_admin_insert" ON public.colleges
  FOR INSERT WITH CHECK (public.get_my_role() = 'super_admin');

-- profiles: super_admin can see Admin accounts (its direct invitees) only —
-- deliberately not every profile in every college.
CREATE POLICY "profiles_super_admin_read_admins" ON public.profiles
  FOR SELECT USING (public.get_my_role() = 'super_admin' AND role = 'admin');
