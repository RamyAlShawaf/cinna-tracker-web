-- =========================================================
--  MVP bus tracking schema (Supabase/Postgres)
--  - Fixes: "WHERE" on table constraint -> partial unique index
--  - Safe-by-default RLS with tiny RPC surface for writes
-- =========================================================

-- Required extensions
create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------
create table if not exists public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null,
  label       text not null,
  public_code text unique not null,  -- shown on QR
  created_at  timestamptz not null default now()
);

create index if not exists idx_vehicles_public_code on public.vehicles(public_code);

-- ---------------------------------------------------------
-- vehicle_sessions
--   One active session per vehicle (operator scans QR and "go")
-- ---------------------------------------------------------
create table if not exists public.vehicle_sessions (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  started_by  uuid,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

-- ✅ Enforce at most one active session per vehicle via partial unique index
create unique index if not exists ux_vehicle_sessions_one_active
  on public.vehicle_sessions (vehicle_id)
  where ended_at is null;

create index if not exists idx_vehicle_sessions_vehicle_started_at
  on public.vehicle_sessions(vehicle_id, started_at desc);

-- ---------------------------------------------------------
-- vehicle_live
--   One live row per vehicle (latest sample)
-- ---------------------------------------------------------
create table if not exists public.vehicle_live (
  vehicle_id uuid primary key references public.vehicles(id) on delete cascade,
  lat        double precision not null check (lat between -90 and 90),
  lng        double precision not null check (lng between -180 and 180),
  speed      double precision,
  heading    double precision,
  accuracy   double precision,
  ts         timestamptz not null default now()
);

-- Optional: auto-refresh ts on updates
create or replace function public._touch_vehicle_live_ts()
returns trigger language plpgsql as $$
begin
  new.ts := now();
  return new;
end$$;

drop trigger if exists trg_touch_vehicle_live_ts on public.vehicle_live;
create trigger trg_touch_vehicle_live_ts
before update on public.vehicle_live
for each row
execute procedure public._touch_vehicle_live_ts();

-- ---------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------
alter table public.vehicles        enable row level security;
alter table public.vehicle_sessions enable row level security;
alter table public.vehicle_live     enable row level security;

-- ---------------------------------------------------------
-- Platform admins (global privileges across all companies)
-- ---------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- Optional: users can read their own admin marker (or restrict to service role only)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='platform_admins' and policyname='read own admin flag'
  ) then
    create policy "read own admin flag"
      on public.platform_admins
      for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

-- ---------------------------------------------------------
-- Company membership (for owner/admin access)
-- ---------------------------------------------------------
create table if not exists public.company_users (
  user_id    uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  role       text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);

alter table public.company_users enable row level security;

-- Owners/admins can read their memberships
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='company_users' and policyname='read own memberships'
  ) then
    create policy "read own memberships"
      on public.company_users
      for select to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

-- Public read for vehicle directory (lookup by code) — MVP
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='vehicles' and policyname='public read vehicles'
  ) then
    create policy "public read vehicles"
      on public.vehicles
      for select
      using (true);
  end if;
end $$;

-- Public read for latest live location (end-user map) — MVP
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='vehicle_live' and policyname='public read live'
  ) then
    create policy "public read live"
      on public.vehicle_live
      for select
      using (true);
  end if;
end $$;

-- Deny direct writes by default (we'll use RPCs / service role)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='vehicle_live' and policyname='deny direct writes'
  ) then
    create policy "deny direct writes"
      on public.vehicle_live
      for all to public
      using (false)
      with check (false);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='vehicle_sessions' and policyname='deny direct session writes'
  ) then
    create policy "deny direct session writes"
      on public.vehicle_sessions
      for all to public
      using (false)
      with check (false);
  end if;
end $$;

-- Optional (comment out if you want sessions visible only to admins):
-- Allow authenticated users to see only their own sessions
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='vehicle_sessions' and policyname='auth read own sessions'
  ) then
    create policy "auth read own sessions"
      on public.vehicle_sessions
      for select to authenticated
      using (started_by = auth.uid());
  end if;
end $$;

-- ---------------------------------------------------------
-- RPCs (SECURITY DEFINER) for operator app
--  These run as the function owner (typically 'postgres' in migrations) so
--  they can perform writes while RLS stays strict for direct table access.
-- ---------------------------------------------------------

-- Start a session by vehicle public_code (ends any stale active one)
create or replace function public.start_vehicle_session(p_public_code text)
returns table (session_id uuid, vehicle_id uuid)  -- handy for the client
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_id uuid;
  v_session_id uuid;
begin
  select v.id into v_vehicle_id
  from public.vehicles v
  where v.public_code = p_public_code;

  if v_vehicle_id is null then
    raise exception 'Vehicle with code % not found', p_public_code using errcode = '22023';
  end if;

  -- Close any lingering active session for this vehicle (defensive)
  update public.vehicle_sessions
     set ended_at = now()
   where vehicle_id = v_vehicle_id
     and ended_at is null;

  insert into public.vehicle_sessions (vehicle_id, started_by)
  values (v_vehicle_id, auth.uid())
  returning id into v_session_id;

  return query select v_session_id, v_vehicle_id;
end $$;

grant execute on function public.start_vehicle_session(text) to authenticated;

-- End a session (only by the starter)
create or replace function public.end_vehicle_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.vehicle_sessions
     set ended_at = now()
   where id = p_session_id
     and ended_at is null
     and (started_by = auth.uid() or auth.uid() is null)  -- allow service role too
  returning 1
  into v_updated;

  return coalesce(v_updated, 0) = 1;
end $$;

grant execute on function public.end_vehicle_session(uuid) to authenticated;

-- Publish a live sample for an active session
create or replace function public.publish_vehicle_live(
  p_session_id uuid,
  p_lat        double precision,
  p_lng        double precision,
  p_speed      double precision default null,
  p_heading    double precision default null,
  p_accuracy   double precision default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_id uuid;
begin
  -- Basic sanity (also covered by CHECKs on the table)
  if p_lat is null or p_lng is null then
    raise exception 'lat/lng required';
  end if;
  if p_lat < -90 or p_lat > 90 then
    raise exception 'lat out of range';
  end if;
  if p_lng < -180 or p_lng > 180 then
    raise exception 'lng out of range';
  end if;

  -- Verify session belongs to the caller and is active
  select s.vehicle_id
    into v_vehicle_id
  from public.vehicle_sessions s
  where s.id = p_session_id
    and s.ended_at is null
    and (s.started_by = auth.uid() or auth.uid() is null); -- service role allowed

  if v_vehicle_id is null then
    raise exception 'Invalid or ended session';
  end if;

  -- Upsert latest position
  insert into public.vehicle_live (vehicle_id, lat, lng, speed, heading, accuracy, ts)
  values (v_vehicle_id, p_lat, p_lng, p_speed, p_heading, p_accuracy, now())
  on conflict (vehicle_id) do update
    set lat      = excluded.lat,
        lng      = excluded.lng,
        speed    = excluded.speed,
        heading  = excluded.heading,
        accuracy = excluded.accuracy,
        ts       = excluded.ts;
end $$;

grant execute on function public.publish_vehicle_live(uuid, double precision, double precision, double precision, double precision, double precision)
  to authenticated;

-- ---------------------------------------------------------
-- Admin-facing convenience view (optional)
-- ---------------------------------------------------------
create or replace view public.vehicle_with_live as
select
  v.id,
  v.company_id,
  v.label,
  v.public_code,
  v.created_at,
  l.lat,
  l.lng,
  l.speed,
  l.heading,
  l.accuracy,
  l.ts as live_ts
from public.vehicles v
left join public.vehicle_live l on l.vehicle_id = v.id;

-- Public can still select from the raw tables due to policies above.
-- You can add a policy for the view if you want to expose it directly.
