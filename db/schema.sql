-- =====================================================================
-- Ramli-Geomancy :: Supabase schema
-- Run this once in the Supabase SQL Editor (or via `supabase db push`).
-- It creates the private user data tables and enables Row Level Security
-- so that every user can ONLY read/write their own history.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. profiles: one row per registered user (linked to Supabase Auth)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null,
  payment_status text not null default 'unpaid'
      check (payment_status in ('unpaid', 'paid')),
  registration_fee_kobo integer not null default 1500000,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. payments: one-time registration fee records (Paystack references)
-- ---------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  amount integer not null default 1500000,
  currency text not null default 'NGN',
  status text not null default 'pending'
      check (status in ('pending', 'paid', 'failed', 'abandoned')),
  authorization_url text,
  transaction jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

-- A user can only ever have ONE successful registration payment.
create unique index if not exists payments_one_paid_per_user
  on public.payments (user_id) where status = 'paid';
create index if not exists payments_user_idx on public.payments (user_id);
create index if not exists payments_reference_idx on public.payments (reference);

-- ---------------------------------------------------------------------
-- 3. ramli_history: private per-user questions / figures / interpretations
-- ---------------------------------------------------------------------
create table if not exists public.ramli_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'ramli',
  question text,
  figures jsonb,
  interpretation text,
  total_points integer,
  created_at timestamptz not null default now()
);

create index if not exists ramli_history_user_idx
  on public.ramli_history (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- 4. Auto-create a profile row whenever a user signs up in Supabase Auth
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, payment_status, registration_fee_kobo)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email,''), '@', 1)),
    'unpaid',
    1500000
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 5. Row Level Security: users only ever see their OWN rows
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.payments     enable row level security;
alter table public.ramli_history enable row level security;

-- profiles: read/update own row only (payment status is set by the
-- service-role backend, which bypasses RLS).
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- payments: read own rows only; writes happen through the service role.
drop policy if exists "payments_select_own" on public.payments;
create policy "payments_select_own" on public.payments
  for select to authenticated using (auth.uid() = user_id);

-- ramli_history: full CRUD limited to the owner of the row.
drop policy if exists "history_select_own" on public.ramli_history;
create policy "history_select_own" on public.ramli_history
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "history_insert_own" on public.ramli_history;
create policy "history_insert_own" on public.ramli_history
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "history_update_own" on public.ramli_history;
create policy "history_update_own" on public.ramli_history
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "history_delete_own" on public.ramli_history;
create policy "history_delete_own" on public.ramli_history
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 6. Keep updated_at fresh
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
