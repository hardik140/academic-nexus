-- 060: atomic decision approval workflow.
--
-- The state transition, audit record, and notifications are one business
-- event. Lock the decision row and perform all writes in one invoker
-- transaction while retaining the existing RLS policies.

CREATE OR REPLACE FUNCTION public.decide_decision(
  p_decision_id UUID,
  p_action TEXT,
  p_reason TEXT DEFAULT NULL,
  p_delegate_to UUID DEFAULT NULL
)
RETURNS TABLE (
  decision_id UUID,
  old_status TEXT,
  title TEXT,
  requested_by UUID,
  delegated_to UUID
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_decision public.decisions%ROWTYPE;
  v_college_id UUID := public.get_my_college_id();
  v_actor_id UUID := auth.uid();
  v_status TEXT;
  v_type TEXT := 'action_required';
BEGIN
  SELECT d.* INTO v_decision
    FROM public.decisions d
   WHERE d.id = p_decision_id
     AND d.college_id = v_college_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Decision not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_decision.status NOT IN ('pending', 'info_requested', 'sent_back') THEN
    RAISE EXCEPTION 'This decision has already been decided.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_decision.requested_by = v_actor_id THEN
    RAISE EXCEPTION 'You cannot decide your own decision request.' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('approved', 'rejected', 'sent_back', 'info_requested', 'delegated', 'withdrawn') THEN
    RAISE EXCEPTION 'Unsupported decision action.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'delegated' THEN
    IF p_delegate_to IS NULL THEN
      RAISE EXCEPTION 'A delegate is required.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = p_delegate_to
         AND p.college_id = v_college_id
         AND p.role IN ('admin', 'director', 'hod', 'warden', 'placement_cell', 'finance')
         AND p.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Delegate is not an active staff member in your college.' USING ERRCODE = '42501';
    END IF;
  ELSIF p_delegate_to IS NOT NULL THEN
    RAISE EXCEPTION 'A delegate is only valid for delegated decisions.' USING ERRCODE = 'check_violation';
  END IF;

  v_status := v_decision.status;
  UPDATE public.decisions
     SET status = p_action,
         decision_reason = p_reason,
         decided_by = CASE WHEN p_action IN ('approved', 'rejected') THEN v_actor_id ELSE decided_by END,
         decided_at = CASE WHEN p_action IN ('approved', 'rejected') THEN now() ELSE decided_at END,
         delegated_to = CASE WHEN p_action = 'delegated' THEN p_delegate_to ELSE delegated_to END
   WHERE id = v_decision.id;

  IF p_action = 'approved' THEN
    v_type := 'success';
  ELSIF p_action = 'rejected' THEN
    v_type := 'error';
  END IF;

  INSERT INTO public.notifications (
    college_id, title, message, receiver_id, sender_id, type
  )
  SELECT
    v_college_id,
    CASE WHEN p_action = 'delegated' AND r.receiver_id = p_delegate_to
      THEN 'Decision delegated to you' ELSE 'Decision update' END,
    CASE WHEN p_action = 'delegated' AND r.receiver_id = p_delegate_to
      THEN format('%s has been delegated to you for review.', v_decision.title)
      ELSE CASE p_action
        WHEN 'approved' THEN format('Your request "%s" was approved.', v_decision.title)
        WHEN 'rejected' THEN format('Your request "%s" was declined.%s', v_decision.title, CASE WHEN p_reason IS NULL THEN '' ELSE ' Reason: ' || p_reason END)
        WHEN 'sent_back' THEN format('"%s" needs more information before it can be decided.%s', v_decision.title, CASE WHEN p_reason IS NULL THEN '' ELSE ' ' || p_reason END)
        WHEN 'info_requested' THEN format('More information was requested for "%s".%s', v_decision.title, CASE WHEN p_reason IS NULL THEN '' ELSE ' ' || p_reason END)
        WHEN 'withdrawn' THEN format('"%s" was withdrawn.', v_decision.title)
        ELSE format('Your request "%s" was updated.', v_decision.title)
      END
    END,
    r.receiver_id,
    v_actor_id,
    v_type
  FROM (SELECT v_decision.requested_by AS receiver_id
        UNION ALL
        SELECT p_delegate_to WHERE p_action = 'delegated') r;

  INSERT INTO public.audit_logs (
    college_id, user_id, action, table_name, record_id, old_value, new_value
  )
  VALUES (
    v_college_id,
    v_actor_id,
    'decision_' || p_action,
    'decisions',
    v_decision.id,
    jsonb_build_object('status', v_status),
    jsonb_build_object('status', p_action, 'decision_reason', p_reason, 'delegated_to', p_delegate_to)
  );

  RETURN QUERY SELECT v_decision.id, v_status, v_decision.title, v_decision.requested_by, p_delegate_to;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_decision(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_decision(UUID, TEXT, TEXT, UUID) TO authenticated;
