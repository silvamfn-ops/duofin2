-- DuoFin 2 v2.8.8 — Registo de Utilizadores e Dispositivos Associados ao Orçamento
-- Cola e executa este script no SQL Editor do teu projeto Supabase (uma única vez).

CREATE TABLE IF NOT EXISTS public.household_devices (
  device_id text NOT NULL,
  household_id uuid NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email text,
  device_name text NOT NULL,
  platform text,
  app_version text,
  last_seen_at bigint NOT NULL,
  PRIMARY KEY (household_id, device_id)
);

ALTER TABLE public.household_devices ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'household_devices' AND policyname = 'household_devices_member_all'
  ) THEN
    CREATE POLICY household_devices_member_all
      ON public.household_devices
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.household_members hm
          WHERE hm.household_id = household_devices.household_id
            AND hm.user_id = auth.uid()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.household_members hm
          WHERE hm.household_id = household_devices.household_id
            AND hm.user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Função segura para listar os emails e funções dos membros do mesmo orçamento
CREATE OR REPLACE FUNCTION public.get_household_members_info(p_household uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  role text,
  joined_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.household_members hm
    WHERE hm.household_id = p_household AND hm.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Sem permissão para consultar membros deste orçamento.';
  END IF;

  RETURN QUERY
  SELECT
    hm.user_id,
    COALESCE(u.email::text, 'Utilizador sem email') AS email,
    COALESCE(hm.role::text, 'member') AS role,
    hm.created_at AS joined_at
  FROM public.household_members hm
  LEFT JOIN auth.users u ON u.id = hm.user_id
  WHERE hm.household_id = p_household
  ORDER BY hm.created_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_household_members_info(uuid) TO authenticated;
