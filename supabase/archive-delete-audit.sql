-- Archived event deletion audit support.
-- Run before deploying the delete-archived-event Edge Function.

create table if not exists public.event_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  event_id uuid,
  event_title text,
  requester_id uuid,
  result text not null,
  storage_failures jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists event_deletion_audit_event_id_idx
on public.event_deletion_audit(event_id);

create index if not exists event_deletion_audit_created_at_idx
on public.event_deletion_audit(created_at desc);

alter table public.event_deletion_audit enable row level security;

drop policy if exists "Owners can read their event deletion audit rows"
on public.event_deletion_audit;

create policy "Owners can read their event deletion audit rows"
on public.event_deletion_audit
for select
to authenticated
using (requester_id = auth.uid());
