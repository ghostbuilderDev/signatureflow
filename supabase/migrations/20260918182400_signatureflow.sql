create extension if not exists pgcrypto;

create table if not exists public.signatureflow_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  storage_path text not null,
  current_storage_path text not null,
  status text not null default 'draft' check (status in ('draft','in_progress','signed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.signatureflow_signers (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.signatureflow_documents(id) on delete cascade,
  name text not null,
  email text not null,
  signing_order integer not null default 1,
  status text not null default 'pending' check (status in ('pending','signing','signed','cancelled')),
  token_hash text,
  token_expires_at timestamptz,
  typed_name text,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(document_id, email)
);

create table if not exists public.signatureflow_signature_fields (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.signatureflow_documents(id) on delete cascade,
  signer_id uuid not null references public.signatureflow_signers(id) on delete cascade,
  page integer not null check (page > 0),
  x numeric not null check (x >= 0 and x <= 1),
  y numeric not null check (y >= 0 and y <= 1),
  width numeric not null check (width > 0 and width <= 1),
  height numeric not null check (height > 0 and height <= 1),
  created_at timestamptz not null default now()
);

create table if not exists public.signatureflow_audit_events (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.signatureflow_documents(id) on delete cascade,
  signer_id uuid references public.signatureflow_signers(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_signatureflow_signers_document on public.signatureflow_signers(document_id, signing_order);
create index if not exists idx_signatureflow_signers_token_hash on public.signatureflow_signers(token_hash) where token_hash is not null;
create index if not exists idx_signatureflow_fields_document on public.signatureflow_signature_fields(document_id, signer_id);
create index if not exists idx_signatureflow_audit_document on public.signatureflow_audit_events(document_id, created_at desc);


-- Accès Data API : seuls les utilisateurs authentifiés gèrent leurs propres dossiers via les politiques RLS.
revoke all on public.signatureflow_documents, public.signatureflow_signers, public.signatureflow_signature_fields, public.signatureflow_audit_events from anon;
grant select, insert, update, delete on public.signatureflow_documents to authenticated;
grant select, insert, update, delete on public.signatureflow_signers to authenticated;
grant select, insert, update, delete on public.signatureflow_signature_fields to authenticated;
grant select on public.signatureflow_audit_events to authenticated;
grant all on public.signatureflow_documents, public.signatureflow_signers, public.signatureflow_signature_fields, public.signatureflow_audit_events to service_role;
grant usage, select on sequence public.signatureflow_audit_events_id_seq to service_role;

alter table public.signatureflow_documents enable row level security;
alter table public.signatureflow_signers enable row level security;
alter table public.signatureflow_signature_fields enable row level security;
alter table public.signatureflow_audit_events enable row level security;

create policy "signatureflow owner documents all" on public.signatureflow_documents
for all to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "signatureflow owner signers all" on public.signatureflow_signers
for all to authenticated
using (exists (select 1 from public.signatureflow_documents d where d.id = document_id and d.owner_id = auth.uid()))
with check (exists (select 1 from public.signatureflow_documents d where d.id = document_id and d.owner_id = auth.uid()));

create policy "signatureflow owner fields all" on public.signatureflow_signature_fields
for all to authenticated
using (exists (select 1 from public.signatureflow_documents d where d.id = document_id and d.owner_id = auth.uid()))
with check (exists (select 1 from public.signatureflow_documents d where d.id = document_id and d.owner_id = auth.uid()));

create policy "signatureflow owner audit read" on public.signatureflow_audit_events
for select to authenticated
using (exists (select 1 from public.signatureflow_documents d where d.id = document_id and d.owner_id = auth.uid()));

insert into storage.buckets (id, name, public)
values ('signatureflow-documents', 'signatureflow-documents', false)
on conflict (id) do update set public = false;

create policy "signatureflow documents owner read" on storage.objects
for select to authenticated
using (bucket_id = 'signatureflow-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "signatureflow documents owner insert" on storage.objects
for insert to authenticated
with check (bucket_id = 'signatureflow-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "signatureflow documents owner update" on storage.objects
for update to authenticated
using (bucket_id = 'signatureflow-documents' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'signatureflow-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "signatureflow documents owner delete" on storage.objects
for delete to authenticated
using (bucket_id = 'signatureflow-documents' and (storage.foldername(name))[1] = auth.uid()::text);
