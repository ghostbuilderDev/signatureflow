-- SignatureFlow 2.1: named signature blocks, reusable contacts and delivery workflows.
alter table public.signatureflow_documents
 add column if not exists workflow_type text not null default 'approval'
   check (workflow_type in ('approval','acknowledgement')),
 add column if not exists completion_mode text not null default 'all_after_complete'
   check (completion_mode in ('all_after_complete','signer_after_each','manual')),
 add column if not exists completion_recipients text[] not null default '{}',
 add column if not exists require_full_read boolean not null default true,
 add column if not exists identity_stamp boolean not null default true,
 add column if not exists prepared_at timestamptz,
 add column if not exists completion_sent_at timestamptz;

alter table public.signatureflow_documents
 add constraint signatureflow_completion_recipient_limit
 check (cardinality(completion_recipients) <= 50);

alter table public.signatureflow_signers
 add column if not exists copy_sent_at timestamptz;

create table if not exists public.signatureflow_contacts (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null check (char_length(name) between 2 and 160),
 email text not null check (char_length(email) between 3 and 254),
 role text not null default '' check (char_length(role) <= 100),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists signatureflow_contacts_owner_email
 on public.signatureflow_contacts(owner_id, lower(email));
alter table public.signatureflow_contacts enable row level security;
revoke all on public.signatureflow_contacts from anon;
grant select,insert,update,delete on public.signatureflow_contacts to authenticated;
grant all on public.signatureflow_contacts to service_role;
create policy signatureflow_contacts_owner on public.signatureflow_contacts
 for all to authenticated
 using (owner_id=(select auth.uid()))
 with check (owner_id=(select auth.uid()));

create table if not exists public.signatureflow_deliveries (
 delivery_key text primary key,
 document_id uuid not null references public.signatureflow_documents(id) on delete cascade,
 signer_id uuid references public.signatureflow_signers(id) on delete set null,
 recipient_email text not null,
 delivery_type text not null check (delivery_type in ('acknowledgement_copy','final_copy')),
 status text not null default 'pending' check (status in ('pending','sent','error')),
 provider_id text,
 error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists signatureflow_deliveries_document
 on public.signatureflow_deliveries(document_id, created_at desc);
alter table public.signatureflow_deliveries enable row level security;
revoke all on public.signatureflow_deliveries from anon,authenticated;
grant select on public.signatureflow_deliveries to authenticated;
grant all on public.signatureflow_deliveries to service_role;
create policy signatureflow_deliveries_owner_read on public.signatureflow_deliveries
 for select to authenticated
 using (exists(select 1 from public.signatureflow_documents d
   where d.id=document_id and d.owner_id=(select auth.uid())));

-- Explicit Data API access is required on projects using the current opt-in model.
grant usage on schema public to authenticated,service_role;
grant insert(id,owner_id,name,storage_path,current_storage_path,page_count,original_sha256,current_sha256,source_ref,signing_mode,workflow_type,completion_mode,completion_recipients,require_full_read,identity_stamp)
 on public.signatureflow_documents to authenticated;
grant update(name,source_ref,signing_mode,workflow_type,completion_mode,completion_recipients,require_full_read,identity_stamp,prepared_at,updated_at)
 on public.signatureflow_documents to authenticated;

-- Any change to recipients or zones invalidates the organizer's final review.
create or replace function public.signatureflow_guard_draft() returns trigger
language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents;
begin
 if current_user in ('authenticated','anon') then
  select * into d from public.signatureflow_documents
   where id=case when TG_OP='DELETE' then old.document_id else new.document_id end
   for update;
  if d.id is null or d.owner_id<>auth.uid() or d.status<>'draft' then
   raise exception 'Document verrouillé';
  end if;
  update public.signatureflow_documents set prepared_at=null where id=d.id;
 end if;
 if TG_OP='DELETE' then return old; else return new; end if;
end;$$;

create or replace function public.signatureflow_document_review_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if old.signing_mode is distinct from new.signing_mode
    or old.workflow_type is distinct from new.workflow_type
    or old.completion_mode is distinct from new.completion_mode
    or old.completion_recipients is distinct from new.completion_recipients
    or old.require_full_read is distinct from new.require_full_read
    or old.identity_stamp is distinct from new.identity_stamp then
  new.prepared_at=null;
 end if;
 return new;
end;$$;
drop trigger if exists signatureflow_document_review_guard on public.signatureflow_documents;
create trigger signatureflow_document_review_guard
 before update on public.signatureflow_documents for each row
 execute function public.signatureflow_document_review_guard();

create or replace function public.signatureflow_save_fields(p_document uuid,p_fields jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents;
begin
 select * into d from public.signatureflow_documents where id=p_document for update;
 if d.id is null or d.owner_id<>auth.uid() or d.status<>'draft' then raise exception 'Dossier non modifiable'; end if;
 if jsonb_typeof(p_fields)<>'array' or jsonb_array_length(p_fields)>500 then raise exception 'Zones invalides (500 maximum)'; end if;
 delete from public.signatureflow_signature_fields where document_id=p_document;
 insert into public.signatureflow_signature_fields(id,document_id,signer_id,page,x,y,width,height,kind,label,required,confidence,detection_source)
 select f.id,p_document,f.signer_id,f.page,f.x,f.y,f.width,f.height,coalesce(f.kind,'signature'),coalesce(f.label,''),coalesce(f.required,true),f.confidence,f.detection_source
 from jsonb_to_recordset(p_fields) as f(id uuid,signer_id uuid,page int,x numeric,y numeric,width numeric,height numeric,kind text,label text,required boolean,confidence numeric,detection_source text);
 if exists(select 1 from public.signatureflow_signature_fields where document_id=p_document and page>coalesce(d.page_count,10000)) then raise exception 'Page inexistante'; end if;
 update public.signatureflow_documents set prepared_at=null,updated_at=now() where id=p_document;
end;$$;

create or replace function public.signatureflow_confirm_preparation(p_document uuid)
returns timestamptz language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents; confirmed_at timestamptz:=now();
begin
 select * into d from public.signatureflow_documents where id=p_document for update;
 if d.id is null or d.owner_id<>auth.uid() or d.status<>'draft' then raise exception 'Dossier non modifiable'; end if;
 if not exists(select 1 from public.signatureflow_signers where document_id=p_document) then raise exception 'Aucun signataire'; end if;
 if not exists(select 1 from public.signatureflow_signature_fields where document_id=p_document) then raise exception 'Aucune zone'; end if;
 if exists(select 1 from public.signatureflow_signers s where s.document_id=p_document and not exists(
   select 1 from public.signatureflow_signature_fields f where f.signer_id=s.id and f.kind in ('signature','initials')
 )) then raise exception 'Chaque signataire doit avoir une zone de signature ou de paraphe'; end if;
 update public.signatureflow_documents set prepared_at=confirmed_at,updated_at=now() where id=p_document;
 return confirmed_at;
end;$$;
revoke all on function public.signatureflow_confirm_preparation(uuid) from public,anon;
grant execute on function public.signatureflow_confirm_preparation(uuid) to authenticated;

create or replace function public.signatureflow_issue(p_document uuid,p_owner uuid,p_links jsonb,p_hash text,p_pages int,p_manifest jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents; recipient_row record; link_value jsonb;
begin
 select * into d from public.signatureflow_documents where id=p_document for update;
 if d.id is null or d.owner_id<>p_owner or d.status not in ('draft','in_progress') then raise exception 'Dossier indisponible'; end if;
 if d.status='draft' and d.prepared_at is null then raise exception 'Validez intégralement le document avant de créer les liens'; end if;
 if d.lock_until>now() then raise exception 'Signature en cours, réessayez'; end if;
 if d.status='draft' and (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from jsonb_to_recordset(p_manifest) as t(id uuid,signer_id uuid,page int,x numeric,y numeric,width numeric,height numeric,kind text,required boolean))<>(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from (select id,signer_id,page,x,y,width,height,kind,required from public.signatureflow_signature_fields where document_id=p_document)t) then raise exception 'Les zones ont changé. Réessayez.'; end if;
 if not exists(select 1 from public.signatureflow_signers where document_id=p_document) then raise exception 'Aucun signataire'; end if;
 if exists(select 1 from public.signatureflow_signers s where s.document_id=p_document and not exists(select 1 from public.signatureflow_signature_fields f where f.signer_id=s.id and f.kind in ('signature','initials'))) then raise exception 'Chaque signataire doit avoir une zone de signature ou de paraphe'; end if;
 for recipient_row in select * from public.signatureflow_signers where document_id=p_document and status<>'signed' loop
  select j into link_value from jsonb_array_elements(p_links) j where j->>'id'=recipient_row.id::text;
  if link_value is null then raise exception 'Liste de liens incomplète'; end if;
  update public.signatureflow_signers set token_hash=link_value->>'hash',token_expires_at=(link_value->>'expires')::timestamptz,status='pending' where id=recipient_row.id;
 end loop;
 update public.signatureflow_documents set status='in_progress',original_sha256=case when d.status='draft' then p_hash else coalesce(original_sha256,p_hash) end,current_sha256=case when d.status='draft' then p_hash else coalesce(current_sha256,p_hash) end,page_count=p_pages,revision=revision+1,updated_at=now() where id=p_document;
 insert into public.signatureflow_audit_events(document_id,event_type,metadata)
 values(p_document,'links_issued',jsonb_build_object('expires_days',14,'mode',d.signing_mode,'workflow_type',d.workflow_type,'completion_mode',d.completion_mode,'prepared_at',d.prepared_at));
end;$$;

revoke all on function public.signatureflow_issue(uuid,uuid,jsonb,text,int,jsonb) from public,anon,authenticated;
grant execute on function public.signatureflow_issue(uuid,uuid,jsonb,text,int,jsonb) to service_role;
