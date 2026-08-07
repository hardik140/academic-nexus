-- ============================================================
-- Migration 017: device_tokens (mobile push notifications)
-- ============================================================
-- Backs the React Native app's push registration
-- (app/api/mobile/push-token/route.ts). sendAnnouncement
-- (director/dashboard/actions.ts) is the only place that writes to
-- `notifications` in the whole app, and reads this table to actually
-- deliver a push for each resolved recipient — see that file for the
-- Expo push integration.

CREATE TABLE IF NOT EXISTS public.device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id UUID NOT NULL REFERENCES public.colleges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON public.device_tokens(user_id);

CREATE TRIGGER set_updated_at_device_tokens
  BEFORE UPDATE ON public.device_tokens
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

-- Each user manages only their own device tokens. sendAnnouncement's push
-- fan-out reads this table via the service-role client (lib/supabase/admin.ts),
-- which bypasses RLS entirely, so no separate staff-read policy is needed.
CREATE POLICY "device_tokens_own" ON public.device_tokens
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
