-- ============================================================================
-- DUOFIN 2 v2.6.0 — ATUALIZAÇÃO DA TABELA recurring_expenses (CADERNO DE ENCARGOS)
-- Executa estas 3 linhas no SQL Editor do Supabase para sincronizar Entidade,
-- Referência e o estado de pagamento por ciclo entre telemóveis e computadores:
-- ============================================================================

alter table public.recurring_expenses
  add column if not exists entity text default '',
  add column if not exists payment_ref text default '',
  add column if not exists cycle_payments jsonb not null default '{}'::jsonb;
