-- 059: atomic decision submission.
--
-- A decision, its Director notifications, and its audit row describe one
-- business event. Keep them in one invoker transaction so RLS remains the
-- authority and a failure in any write rolls back the whole submission.

CREATE OR REPLACE FUNCTION public.submit_decision(
  p_category TEXT,
  p_title TEXT,
  p_description TEXT,
  p_urgency TEXT DEFAULT 'medium',
  p_financial_impact NUMERIC DEFAULT NULL,
  p_student_impact_count INTEGER DEFAULT NULL,
  p_institutional_impact_summary TEXT DEFAULT NULL,
  p_recommendation TEXT DEFAULT NULL,
  p_deadline DATE DEFAULT NULL
)
RETURNS TABLE (decision_id UUID)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_college_id UUID := public.get_my_college_id();
  v_actor_id UUID := auth.uid();
  v_decision public.decisions%ROWTYPE;
BEGIN
  IF v_college_id IS NULL OR v_actor_id IS NULL THEN
    RAISE EXCEPTION 'An authenticated college session is required.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.decisions (
    college_id,
    category,
    title,
    description,
    requested_by,
    department_id,
    urgency,
    financial_impact,
    student_impact_count,
    institutional_impact_summary,
    recommendation,
    deadline,
    status,
    source
  )
  SELECT
    v_college_id,
    p_category,
    p_title,
    p_description,
    v_actor_id,
    d.id,
    COALESCE(p_urgency, 'medium'),
    p_financial_impact,
    p_student_impact_count,
    p_institutional_impact_summary,
    p_recommendation,
    p_deadline,
    'pending',
    'human'
  FROM (SELECT d.id FROM public.departments d WHERE d.college_id = v_college_id AND d.hod_id = v_actor_id LIMIT 1) d
  WHERE public.get_my_role() = 'hod'
  RETURNING * INTO v_decision;

  IF NOT FOUND THEN
    INSERT INTO public.decisions (
      college_id,
      category,
      title,
      description,
      requested_by,
      urgency,
      financial_impact,
      student_impact_count,
      institutional_impact_summary,
      recommendation,
      deadline,
      status,
      source
    )
    SELECT
      v_college_id,
      p_category,
      p_title,
      p_description,
      v_actor_id,
      COALESCE(p_urgency, 'medium'),
      p_financial_impact,
      p_student_impact_count,
      p_institutional_impact_summary,
      p_recommendation,
      p_deadline,
      'pending',
      'human'
    WHERE public.get_my_role() IN ('warden', 'placement_cell')
    RETURNING * INTO v_decision;
  END IF;

  IF v_decision.id IS NULL THEN
    RAISE EXCEPTION 'You are not allowed to submit a decision.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.notifications (
    college_id, title, message, receiver_id, sender_id, type, link
  )
  SELECT
    v_college_id,
    'New decision required',
    v_decision.title || ' (' || v_decision.urgency || ' urgency)',
    p.id,
    v_actor_id,
    'action_required',
    '/director/decisions/' || v_decision.id::text
  FROM public.profiles p
  WHERE p.college_id = v_college_id AND p.role = 'director';

  INSERT INTO public.audit_logs (
    college_id, user_id, action, table_name, record_id, old_value, new_value
  )
  VALUES (
    v_college_id,
    v_actor_id,
    'decision_submitted',
    'decisions',
    v_decision.id,
    NULL,
    jsonb_build_object('status', 'pending', 'category', v_decision.category, 'urgency', v_decision.urgency)
  );

  RETURN QUERY SELECT v_decision.id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_decision(TEXT, TEXT, TEXT, TEXT, NUMERIC, INTEGER, TEXT, TEXT, DATE)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_decision(TEXT, TEXT, TEXT, TEXT, NUMERIC, INTEGER, TEXT, TEXT, DATE)
  TO authenticated;
