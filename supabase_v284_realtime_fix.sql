-- DuoFin 2 v2.8.4 — Ativação de Sincronização Instantânea (Supabase Realtime)
-- Cola e executa este script no SQL Editor do teu projeto Supabase (uma única vez).

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'households',
    'household_meta',
    'categories',
    'credit_cards',
    'savings_goals',
    'recurring_expenses',
    'transactions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL;', tbl);
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I;', tbl);
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END;
  END LOOP;
END $$;
