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
  status     text not null default 'online' check (status in ('online','paused')),
  route      jsonb,
  ts         timestamptz not null default now()
);

-- Ensure status column exists for existing databases created before this change
alter table if exists public.vehicle_live
  add column if not exists status text not null default 'online' check (status in ('online','paused'));
alter table if exists public.vehicle_live
  add column if not exists route jsonb;

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
-- Ensure old overload is removed to avoid PostgREST 300 (multiple choices)
drop function if exists public.publish_vehicle_live(uuid, double precision, double precision, double precision, double precision, double precision);
create or replace function public.publish_vehicle_live(
  p_session_id uuid,
  p_lat        double precision,
  p_lng        double precision,
  p_speed      double precision default null,
  p_heading    double precision default null,
  p_accuracy   double precision default null,
  p_route      jsonb default null
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
  insert into public.vehicle_live (vehicle_id, lat, lng, speed, heading, accuracy, status, route, ts)
  values (v_vehicle_id, p_lat, p_lng, p_speed, p_heading, p_accuracy, 'online', p_route, now())
  on conflict (vehicle_id) do update
    set lat      = excluded.lat,
        lng      = excluded.lng,
        speed    = excluded.speed,
        heading  = excluded.heading,
        accuracy = excluded.accuracy,
        route    = excluded.route,
        status   = 'online',
        ts       = excluded.ts;
end $$;

grant execute on function public.publish_vehicle_live(uuid, double precision, double precision, double precision, double precision, double precision, jsonb)
  to authenticated;

-- Allow operators to explicitly set status (e.g., pause/resume) without sending a location
create or replace function public.set_vehicle_status(
  p_session_id uuid,
  p_status     text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_id uuid;
begin
  if p_status not in ('online','paused') then
    raise exception 'Invalid status';
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

  -- Update status if a live row exists; do not insert a dummy row without lat/lng
  update public.vehicle_live
     set status = p_status,
         ts     = now()
   where vehicle_id = v_vehicle_id;
end $$;

grant execute on function public.set_vehicle_status(uuid, text) to authenticated;

-- ---------------------------------------------------------
-- trips and trip_stops (route scaffolding for end-user pathing)
-- ---------------------------------------------------------

-- trips (per company)
create table if not exists public.trips (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  code        text unique,
  path_polyline text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_trips_company_id on public.trips(company_id);

-- ordered stops within a trip
create table if not exists public.trip_stops (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  name          text not null,
  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  sequence      int not null check (sequence >= 1),
  dwell_seconds int,
  created_at    timestamptz not null default now()
);

create unique index if not exists ux_trip_stops_trip_sequence
  on public.trip_stops(trip_id, sequence);

-- attach a trip to an operator's active session
alter table if exists public.vehicle_sessions
  add column if not exists trip_id uuid references public.trips(id);

create index if not exists idx_vehicle_sessions_trip_id on public.vehicle_sessions(trip_id);

-- RLS for trips and trip_stops
alter table public.trips enable row level security;
alter table public.trip_stops enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='trips' and policyname='public read trips'
  ) then
    create policy "public read trips"
      on public.trips
      for select
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='trip_stops' and policyname='public read trip_stops'
  ) then
    create policy "public read trip_stops"
      on public.trip_stops
      for select
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='trips' and policyname='deny direct writes'
  ) then
    create policy "deny direct writes"
      on public.trips
      for all to public
      using (false)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='trip_stops' and policyname='deny direct writes'
  ) then
    create policy "deny direct writes"
      on public.trip_stops
      for all to public
      using (false)
      with check (false);
  end if;
end $$;

 

-- RPC: assign a trip to an active session (starter or service role)
create or replace function public.assign_trip_to_session(
  p_session_id uuid,
  p_trip_id    uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vehicle_company uuid;
  v_trip_company    uuid;
  v_updated int;
begin
  select c.id
    into v_vehicle_company
  from public.vehicle_sessions s
  join public.vehicles v on v.id = s.vehicle_id
  join public.companies c on c.id = v.company_id
  where s.id = p_session_id
    and s.ended_at is null
    and (s.started_by = auth.uid() or auth.uid() is null);

  select company_id into v_trip_company
  from public.trips
  where id = p_trip_id;

  if v_vehicle_company is null or v_trip_company is null or v_vehicle_company <> v_trip_company then
    raise exception 'Trip and session vehicle must belong to same company';
  end if;

  update public.vehicle_sessions
     set trip_id = p_trip_id
   where id = p_session_id
   returning 1 into v_updated;

  return coalesce(v_updated, 0) = 1;
end $$;

grant execute on function public.assign_trip_to_session(uuid, uuid) to authenticated;

-- RPC: clear trip from a session
create or replace function public.clear_trip_from_session(
  p_session_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.vehicle_sessions s
     set trip_id = null
   where s.id = p_session_id
     and s.ended_at is null
     and (s.started_by = auth.uid() or auth.uid() is null)
   returning 1 into v_updated;

  return coalesce(v_updated, 0) = 1;
end $$;

grant execute on function public.clear_trip_from_session(uuid) to authenticated;
