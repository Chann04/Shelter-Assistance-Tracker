-- =====================================================================
-- Shelter Assistance Tracker
-- Full schema + RPC functions (raw SQL, no ORM)
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1) Tables
-- ---------------------------------------------------------------------

create table if not exists public.shelter_users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'Staff' check (role in ('Staff', 'Admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  gender text,
  birth_date date,
  contact_number text,
  id_number text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (id_number)
);

create table if not exists public.supplies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in ('Food', 'Blanket', 'Medicine', 'Hygiene', 'Other')),
  unit text not null default 'pcs',
  quantity_in_stock integer not null default 0 check (quantity_in_stock >= 0),
  reorder_level integer not null default 0 check (reorder_level >= 0),
  expires_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.assistance_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  requested_by uuid references public.shelter_users(id) on delete set null,
  category text not null check (category in ('Housing', 'Food', 'Supplies', 'Medical')),
  status text not null default 'Pending' check (status in ('Pending', 'Approved', 'Fulfilled', 'Cancelled')),
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Urgent')),
  request_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.distributions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.assistance_requests(id) on delete cascade,
  supply_id uuid not null references public.supplies(id) on delete restrict,
  quantity_distributed integer not null check (quantity_distributed > 0),
  distributed_by uuid references public.shelter_users(id) on delete set null,
  distributed_at timestamptz not null default now(),
  notes text
);

create index if not exists idx_clients_name on public.clients(last_name, first_name);
create index if not exists idx_requests_status_category on public.assistance_requests(status, category);
create index if not exists idx_requests_client on public.assistance_requests(client_id);
create index if not exists idx_distributions_request on public.distributions(request_id);
create index if not exists idx_distributions_supply on public.distributions(supply_id);

-- ---------------------------------------------------------------------
-- 2) Triggers
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_shelter_users on public.shelter_users;
create trigger trg_set_updated_at_shelter_users
before update on public.shelter_users
for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at_clients on public.clients;
create trigger trg_set_updated_at_clients
before update on public.clients
for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at_supplies on public.supplies;
create trigger trg_set_updated_at_supplies
before update on public.supplies
for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at_requests on public.assistance_requests;
create trigger trg_set_updated_at_requests
before update on public.assistance_requests
for each row execute function public.set_updated_at();

-- keep stock in sync whenever a distribution is inserted
create or replace function public.apply_distribution_stock_change()
returns trigger
language plpgsql
as $$
declare
  current_stock integer;
begin
  select quantity_in_stock into current_stock
  from public.supplies
  where id = new.supply_id
  for update;

  if current_stock is null then
    raise exception 'Supply not found';
  end if;

  if current_stock < new.quantity_distributed then
    raise exception 'Insufficient stock';
  end if;

  update public.supplies
  set quantity_in_stock = quantity_in_stock - new.quantity_distributed,
      updated_at = now()
  where id = new.supply_id;

  return new;
end;
$$;

drop trigger if exists trg_apply_distribution_stock_change on public.distributions;
create trigger trg_apply_distribution_stock_change
before insert on public.distributions
for each row execute function public.apply_distribution_stock_change();

-- ---------------------------------------------------------------------
-- 3) RLS
-- ---------------------------------------------------------------------

alter table public.shelter_users enable row level security;
alter table public.clients enable row level security;
alter table public.supplies enable row level security;
alter table public.assistance_requests enable row level security;
alter table public.distributions enable row level security;

drop policy if exists "users self read" on public.shelter_users;
create policy "users self read"
on public.shelter_users
for select
to authenticated
using (id = auth.uid() or exists (
  select 1 from public.shelter_users su
  where su.id = auth.uid() and su.role = 'Admin' and su.is_active = true
));

drop policy if exists "staff full access clients" on public.clients;
create policy "staff full access clients"
on public.clients
for all
to authenticated
using (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true))
with check (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true));

drop policy if exists "staff full access supplies" on public.supplies;
create policy "staff full access supplies"
on public.supplies
for all
to authenticated
using (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true))
with check (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true));

drop policy if exists "staff full access requests" on public.assistance_requests;
create policy "staff full access requests"
on public.assistance_requests
for all
to authenticated
using (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true))
with check (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true));

drop policy if exists "staff full access distributions" on public.distributions;
create policy "staff full access distributions"
on public.distributions
for all
to authenticated
using (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true))
with check (exists (select 1 from public.shelter_users su where su.id = auth.uid() and su.is_active = true));

-- ---------------------------------------------------------------------
-- 4) RPC functions (Aggregation, JOINs, Subqueries, CTE)
-- ---------------------------------------------------------------------

-- Aggregation RPC: COUNT requests + SUM distributed
create or replace function public.rpc_dashboard_summary()
returns table (
  total_clients bigint,
  active_requests bigint,
  supplies_units_distributed bigint,
  current_inventory_units bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.clients) as total_clients,
    (select count(*) from public.assistance_requests where status in ('Pending', 'Approved')) as active_requests,
    (select coalesce(sum(quantity_distributed), 0) from public.distributions) as supplies_units_distributed,
    (select coalesce(sum(quantity_in_stock), 0) from public.supplies) as current_inventory_units;
$$;

-- JOIN-heavy master report (clients + requests + distributions + supplies)
create or replace function public.rpc_master_report(
  p_category text default null,
  p_status text default null
)
returns table (
  request_id uuid,
  request_created_at timestamptz,
  request_status text,
  request_category text,
  client_id uuid,
  client_name text,
  client_contact text,
  distribution_id uuid,
  distributed_at timestamptz,
  supply_name text,
  supply_category text,
  quantity_distributed integer
)
language sql
security definer
set search_path = public
as $$
  select
    ar.id as request_id,
    ar.created_at as request_created_at,
    ar.status as request_status,
    ar.category as request_category,
    c.id as client_id,
    c.last_name || ', ' || c.first_name as client_name,
    c.contact_number as client_contact,
    d.id as distribution_id,
    d.distributed_at,
    s.name as supply_name,
    s.category as supply_category,
    d.quantity_distributed
  from public.assistance_requests ar
  join public.clients c on c.id = ar.client_id
  left join public.distributions d on d.request_id = ar.id
  left join public.supplies s on s.id = d.supply_id
  where (p_category is null or ar.category = p_category)
    and (p_status is null or ar.status = p_status)
  order by ar.created_at desc, d.distributed_at desc nulls last;
$$;

-- Subquery #1: clients with above-average request count
create or replace function public.rpc_clients_above_avg_requests()
returns table (
  client_id uuid,
  client_name text,
  request_count bigint
)
language sql
security definer
set search_path = public
as $$
  with per_client as (
    select c.id, c.first_name, c.last_name, count(ar.id) as request_count
    from public.clients c
    left join public.assistance_requests ar on ar.client_id = c.id
    group by c.id, c.first_name, c.last_name
  )
  select
    pc.id as client_id,
    pc.last_name || ', ' || pc.first_name as client_name,
    pc.request_count
  from per_client pc
  where pc.request_count > (
    select avg(x.request_count)::numeric
    from per_client x
  )
  order by pc.request_count desc, client_name asc;
$$;

-- Subquery #2: supplies below reorder level
create or replace function public.rpc_supplies_below_reorder()
returns table (
  supply_id uuid,
  supply_name text,
  quantity_in_stock integer,
  reorder_level integer
)
language sql
security definer
set search_path = public
as $$
  select s.id, s.name, s.quantity_in_stock, s.reorder_level
  from public.supplies s
  where s.quantity_in_stock < (
    select coalesce(min(s2.reorder_level), 0)
    from public.supplies s2
    where s2.id = s.id
  )
  order by s.quantity_in_stock asc, s.name asc;
$$;

-- Subquery #3: requests with total distribution above average per request
create or replace function public.rpc_requests_above_avg_distribution()
returns table (
  request_id uuid,
  total_distributed bigint
)
language sql
security definer
set search_path = public
as $$
  with totals as (
    select ar.id as request_id, coalesce(sum(d.quantity_distributed), 0) as total_distributed
    from public.assistance_requests ar
    left join public.distributions d on d.request_id = ar.id
    group by ar.id
  )
  select t.request_id, t.total_distributed
  from totals t
  where t.total_distributed > (
    select avg(t2.total_distributed)::numeric from totals t2
  )
  order by t.total_distributed desc;
$$;

-- CTE report: monthly assistance trend
create or replace function public.rpc_monthly_assistance_trend(
  p_months int default 12
)
returns table (
  month_start date,
  requests_count bigint,
  fulfilled_count bigint,
  distributed_units bigint
)
language sql
security definer
set search_path = public
as $$
  with months as (
    select date_trunc('month', current_date) - (interval '1 month' * g.n) as month_start
    from generate_series(0, greatest(p_months, 1) - 1) as g(n)
  ),
  req as (
    select date_trunc('month', created_at) as month_start,
           count(*) as requests_count,
           count(*) filter (where status = 'Fulfilled') as fulfilled_count
    from public.assistance_requests
    group by 1
  ),
  dist as (
    select date_trunc('month', distributed_at) as month_start,
           coalesce(sum(quantity_distributed), 0) as distributed_units
    from public.distributions
    group by 1
  )
  select
    m.month_start::date,
    coalesce(r.requests_count, 0) as requests_count,
    coalesce(r.fulfilled_count, 0) as fulfilled_count,
    coalesce(d.distributed_units, 0) as distributed_units
  from months m
  left join req r on r.month_start = m.month_start
  left join dist d on d.month_start = m.month_start
  order by m.month_start asc;
$$;
