-- DuoFin 2 v2.9.0 — Perfis de Administrador / Utilizador e Convites Direcionados por Email
-- Cola e executa este script no SQL Editor do teu projeto Supabase (uma única vez).

ALTER TABLE public.household_invites
  ADD COLUMN IF NOT EXISTS invited_email text,
  ADD COLUMN IF NOT EXISTS invited_role text NOT NULL DEFAULT 'member';

CREATE OR REPLACE FUNCTION public.is_household_admin(p_household uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.household_members hm
    WHERE hm.household_id = p_household
      AND hm.user_id = auth.uid()
      AND COALESCE(hm.role, 'owner') IN ('owner', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_household_admin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_invite_v3(
  p_household uuid,
  p_email text DEFAULT NULL,
  p_role text DEFAULT 'member'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_role text;
  v_email text;
BEGIN
  IF NOT public.is_household_admin(p_household) THEN
    RAISE EXCEPTION 'Apenas um Administrador pode gerar convites para este orçamento.';
  END IF;

  v_role := CASE WHEN lower(trim(COALESCE(p_role, 'member'))) IN ('admin', 'owner') THEN 'admin' ELSE 'member' END;
  v_email := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));

  INSERT INTO public.household_invites (code, household_id, created_by, invited_email, invited_role, expires_at)
  VALUES (v_code, p_household, auth.uid(), v_email, v_role, now() + interval '7 days');

  RETURN v_code;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_invite_v3(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.accept_invite_v2(p_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_user_email text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Inicia sessão antes de aceitar um convite.';
  END IF;

  SELECT lower(trim(email)) INTO v_user_email FROM auth.users WHERE id = auth.uid();

  SELECT * INTO v_inv
  FROM public.household_invites
  WHERE upper(trim(code)) = upper(trim(p_code))
    AND expires_at > now()
  ORDER BY expires_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Código de convite inválido ou expirado.';
  END IF;

  IF v_inv.invited_email IS NOT NULL AND trim(v_inv.invited_email) <> '' THEN
    IF lower(trim(v_inv.invited_email)) <> COALESCE(v_user_email, '') THEN
      RAISE EXCEPTION 'Este convite foi emitido especificamente para o email %.', v_inv.invited_email;
    END IF;
  END IF;

  INSERT INTO public.household_members (household_id, user_id, role)
  VALUES (v_inv.household_id, auth.uid(), COALESCE(v_inv.invited_role, 'member'))
  ON CONFLICT (household_id, user_id)
  DO UPDATE SET role = EXCLUDED.role;

  DELETE FROM public.household_invites WHERE code = v_inv.code;

  RETURN v_inv.household_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_invite_v2(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_pending_email_invites()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_email text;
  v_inv record;
  v_hid uuid := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT lower(trim(email)) INTO v_user_email FROM auth.users WHERE id = auth.uid();
  IF v_user_email IS NULL OR v_user_email = '' THEN
    RETURN NULL;
  END IF;

  FOR v_inv IN
    SELECT * FROM public.household_invites
    WHERE lower(trim(invited_email)) = v_user_email
      AND expires_at > now()
    ORDER BY expires_at DESC
  LOOP
    INSERT INTO public.household_members (household_id, user_id, role)
    VALUES (v_inv.household_id, auth.uid(), COALESCE(v_inv.invited_role, 'member'))
    ON CONFLICT (household_id, user_id)
    DO UPDATE SET role = EXCLUDED.role;

    v_hid := v_inv.household_id;
    DELETE FROM public.household_invites WHERE code = v_inv.code;
  END LOOP;

  RETURN v_hid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_pending_email_invites() TO authenticated;

CREATE OR REPLACE FUNCTION public.update_household_member_role(
  p_household uuid,
  p_target_user uuid,
  p_new_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_admin_count int;
BEGIN
  IF NOT public.is_household_admin(p_household) THEN
    RAISE EXCEPTION 'Apenas um Administrador pode alterar perfis de acesso.';
  END IF;

  v_role := CASE WHEN lower(trim(COALESCE(p_new_role, 'member'))) IN ('admin', 'owner') THEN 'admin' ELSE 'member' END;

  IF v_role = 'member' THEN
    SELECT count(*) INTO v_admin_count
    FROM public.household_members
    WHERE household_id = p_household
      AND COALESCE(role, 'owner') IN ('owner', 'admin')
      AND user_id <> p_target_user;
    IF v_admin_count < 1 THEN
      RAISE EXCEPTION 'Tem de existir pelo menos um Administrador ativo no orçamento.';
    END IF;
  END IF;

  UPDATE public.household_members
  SET role = v_role
  WHERE household_id = p_household AND user_id = p_target_user;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_household_member_role(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_household_member(
  p_household uuid,
  p_target_user uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_count int;
BEGIN
  IF NOT public.is_household_admin(p_household) THEN
    RAISE EXCEPTION 'Apenas um Administrador pode remover utilizadores do orçamento.';
  END IF;

  SELECT count(*) INTO v_admin_count
  FROM public.household_members
  WHERE household_id = p_household
    AND COALESCE(role, 'owner') IN ('owner', 'admin')
    AND user_id <> p_target_user;

  IF v_admin_count < 1 THEN
    RAISE EXCEPTION 'Não podes remover o único Administrador do orçamento.';
  END IF;

  DELETE FROM public.household_members
  WHERE household_id = p_household AND user_id = p_target_user;

  DELETE FROM public.household_devices
  WHERE household_id = p_household AND user_id = p_target_user;
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_household_member(uuid, uuid) TO authenticated;

DO $$
DECLARE
  struct_tbl text;
  struct_tables text[] := ARRAY['household_meta', 'categories', 'credit_cards', 'recurring_expenses'];
  pol record;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('households', 'household_meta', 'categories', 'credit_cards', 'recurring_expenses')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', pol.policyname, pol.tablename);
  END LOOP;

  CREATE POLICY households_member_select ON public.households
    FOR SELECT USING (
      EXISTS (SELECT 1 FROM public.household_members hm WHERE hm.household_id = households.id AND hm.user_id = auth.uid())
    );
  CREATE POLICY households_admin_write ON public.households
    FOR ALL USING (public.is_household_admin(id)) WITH CHECK (public.is_household_admin(id));

  FOREACH struct_tbl IN ARRAY struct_tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (EXISTS (SELECT 1 FROM public.household_members hm WHERE hm.household_id = %I.household_id AND hm.user_id = auth.uid()));',
      struct_tbl || '_member_select', struct_tbl, struct_tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.is_household_admin(household_id));',
      struct_tbl || '_admin_insert', struct_tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (public.is_household_admin(household_id)) WITH CHECK (public.is_household_admin(household_id));',
      struct_tbl || '_admin_update', struct_tbl
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (public.is_household_admin(household_id));',
      struct_tbl || '_admin_delete', struct_tbl
    );
  END LOOP;
END $$;
