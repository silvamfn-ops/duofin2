-- ============================================================================
-- DUOFIN 2.0 — ESQUEMA DE BASE DE DADOS SUPABASE (NORMALIZADO + REALTIME + RLS)
-- ============================================================================
create extension if not exists "pgcrypto";

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Orçamento do Casal',
  income_ref numeric(12,2) default 3200,
  cycle_grouping_days int default 14,
  adult1_name text default 'Adulto 1',
  adult2_name text default 'Adulto 2',
  auto_adjust_budgets boolean default false,
  created_at timestamptz default now(),
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists public.household_members (
  household_id uuid references public.households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text default 'member',
  joined_at timestamptz default now(),
  primary key (household_id, user_id)
);

create table if not exists public.household_invites (
  code text primary key,
  household_id uuid references public.households(id) on delete cascade,
  created_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days')
);

create table if not exists public.categories (
  id text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  budget numeric(12,2) not null default 0,
  locked boolean default false,
  sort_order int default 0,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  deleted_at bigint
);

create table if not exists public.credit_cards (
  id text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  card_limit numeric(12,2) default 0,
  initial_debt numeric(12,2) default 0,
  owner text default 'Conta conjunta',
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  deleted_at bigint
);

create table if not exists public.savings_goals (
  id text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  target numeric(12,2) not null,
  deadline date,
  status text default 'active',
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  deleted_at bigint
);

create table if not exists public.recurring_expenses (
  id text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  description text not null,
  amount numeric(12,2) not null,
  category text not null,
  person text not null,
  day_of_month int not null check (day_of_month between 1 and 31),
  start_month text not null,
  end_month text,
  active boolean default true,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  deleted_at bigint
);

create table if not exists public.transactions (
  id text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  date date not null,
  type text not null check (type in ('expense','cc_payment','income','saving','saving_withdraw')),
  description text not null,
  amount numeric(12,2) not null,
  category text not null,
  person text not null,
  status text default 'confirmed',
  credit_card_id text,
  goal_id text,
  recurrence_id text,
  occurrence_key text,
  installment_group_id text,
  counts_for_cycle boolean default true,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  deleted_at bigint
);

create table if not exists public.household_meta (
  household_id uuid primary key references public.households(id) on delete cascade,
  category_rules jsonb default '[]'::jsonb,
  handled_rollovers jsonb default '[]'::jsonb,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create index if not exists idx_tx_household_date on public.transactions(household_id, date desc);
create index if not exists idx_tx_updated on public.transactions(household_id, updated_at);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.categories enable row level security;
alter table public.credit_cards enable row level security;
alter table public.savings_goals enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.transactions enable row level security;
alter table public.household_meta enable row level security;

create or replace function public.is_household_member(hid uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.household_members
    where household_id = hid and user_id = auth.uid()
  );
$$;

drop policy if exists "Membros veem o seu household" on public.households;
create policy "Membros veem o seu household" on public.households
  for all using (public.is_household_member(id)) with check (public.is_household_member(id));

drop policy if exists "Membros veem membros do mesmo household" on public.household_members;
create policy "Membros veem membros do mesmo household" on public.household_members
  for select using (public.is_household_member(household_id));

drop policy if exists "Membros gerem categorias" on public.categories;
create policy "Membros gerem categorias" on public.categories
  for all using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

drop policy if exists "Membros gerem cartões" on public.credit_cards;
create policy "Membros gerem cartões" on public.credit_cards
  for all using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

drop policy if exists "Membros gerem objetivos" on public.savings_goals;
create policy "Membros gerem objetivos" on public.savings_goals
  for all using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

drop policy if exists "Membros gerem recorrências" on public.recurring_expenses;
create policy "Membros gerem recorrências" on public.recurring_expenses
  for all using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

drop policy if exists "Membros gerem transações" on public.transactions;
create policy "Membros gerem transações" on public.transactions
  for all using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

drop policy if exists "Membros gerem meta" on public.household_meta;
create policy "Membros gerem meta" on public.household_meta
  for all using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));

create or replace function public.create_household_v2(p_name text)
returns uuid language plpgsql security definer as $$
declare
  new_hid uuid;
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  insert into public.households (name, updated_at) values (coalesce(nullif(trim(p_name),''), 'Orçamento do Casal'), now_ms) returning id into new_hid;
  insert into public.household_members (household_id, user_id, role) values (new_hid, auth.uid(), 'owner');
  insert into public.household_meta (household_id, updated_at) values (new_hid, now_ms);

  insert into public.categories (id, household_id, name, budget, sort_order, updated_at) values
    ('cat-hab-' || new_hid, new_hid, 'Habitação', 850, 1, now_ms),
    ('cat-sup-' || new_hid, new_hid, 'Supermercado', 450, 2, now_ms),
    ('cat-ene-' || new_hid, new_hid, 'Água, luz e gás', 180, 3, now_ms),
    ('cat-tra-' || new_hid, new_hid, 'Transportes', 250, 4, now_ms),
    ('cat-tel-' || new_hid, new_hid, 'Telecomunicações', 70, 5, now_ms),
    ('cat-sau-' || new_hid, new_hid, 'Saúde e farmácia', 80, 6, now_ms),
    ('cat-fam-' || new_hid, new_hid, 'Crianças e família', 150, 7, now_ms),
    ('cat-laz-' || new_hid, new_hid, 'Restaurantes e lazer', 150, 8, now_ms),
    ('cat-ves-' || new_hid, new_hid, 'Vestuário e pessoal', 120, 9, now_ms),
    ('cat-out-' || new_hid, new_hid, 'Outros / imprevistos', 300, 10, now_ms);
  return new_hid;
end;
$$;

create or replace function public.create_invite_v2(p_household uuid)
returns text language plpgsql security definer as $$
declare
  invite_code text;
begin
  if not public.is_household_member(p_household) then raise exception 'Sem permissão'; end if;
  invite_code := upper(substr(md5(random()::text), 1, 6));
  insert into public.household_invites (code, household_id, created_by) values (invite_code, p_household, auth.uid());
  return invite_code;
end;
$$;

create or replace function public.accept_invite_v2(p_code text)
returns uuid language plpgsql security definer as $$
declare
  target_hid uuid;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  select household_id into target_hid from public.household_invites
  where code = upper(trim(p_code)) and expires_at > now();
  if target_hid is null then raise exception 'Código inválido ou expirado'; end if;
  insert into public.household_members (household_id, user_id, role)
  values (target_hid, auth.uid(), 'member')
  on conflict do nothing;
  delete from public.household_invites where code = upper(trim(p_code));
  return target_hid;
end;
$$;

alter publication supabase_realtime add table public.transactions;
alter publication supabase_realtime add table public.categories;
alter publication supabase_realtime add table public.credit_cards;
alter publication supabase_realtime add table public.savings_goals;
alter publication supabase_realtime add table public.recurring_expenses;
alter publication supabase_realtime add table public.households;
alter publication supabase_realtime add table public.household_meta;
