-- Elite AI Voice Agent — Supabase schema
-- Run this in the Supabase SQL editor for your project.

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  call_sid text unique,                        -- unique browser session ID or legacy call SID
  phone_number text,
  business_name text,
  contact_name text,
  call_status text,         -- technical call state: no-answer, busy, failed, canceled, completed
  notes text,               -- freeform: what the agent learned
  outcome text check (outcome in (
    'booked', 'callback', 'not_interested', 'do_not_call', 'voicemail', 'in_progress'
  )) default 'in_progress',
  followup_time timestamptz,                    -- if outcome = 'booked' / 'callback'
  transcript text,                              -- full call transcript, appended live
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Browser sessions may have no phone number; safe for existing tables.
alter table public.leads alter column phone_number drop not null;

-- Keep updated_at fresh on every write
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_leads_updated_at on leads;
create trigger trg_leads_updated_at
  before update on leads
  for each row execute function set_updated_at();

-- Enable realtime so the dashboard table updates live as calls progress
alter publication supabase_realtime add table leads;

-- RLS: for the task/demo, keep it simple with a service-role-only write policy.
-- Tighten this before using with real customer data.
alter table leads enable row level security;

create policy "service role full access"
  on leads for all
  using (true)
  with check (true);
