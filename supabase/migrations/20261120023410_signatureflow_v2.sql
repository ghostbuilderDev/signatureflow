-- Additive upgrade: existing documents and signatures are retained.
alter table public.signatureflow_documents
 add column if not exists revision integer not null default 0,
 add column if not exists page_count integer,
 add column if not exists original_sha256 text,
 add column if not exists current_sha256 text,
 add column if not exists signing_mode text not null default 'parallel' check(signing_mode in ('parallel','sequential')),
 add column if not exists source_ref text,
 add column if not exists lock_id uuid,
 add column if not exists lock_until timestamptz;
alter table public.signatureflow_signers add column if not exists role text not null default '',
 add column if not exists request_id uuid, add column if not exists result_sha256 text;
alter table public.signatureflow_signature_fields
 add column if not exists kind text not null default 'signature' check(kind in ('signature','initials','name','date','text','checkbox')),
 add column if not exists label text not null default '',
 add column if not exists required boolean not null default true,
 add column if not exists confidence numeric,
 add column if not exists detection_source text;
-- Remove cross-document assignments inherited from V1 before adding the composite FK.
delete from public.signatureflow_signature_fields f where not exists(select 1 from public.signatureflow_signers s where s.id=f.signer_id and s.document_id=f.document_id);
alter table public.signatureflow_signers add constraint signatureflow_signer_document_unique unique(id,document_id);
alter table public.signatureflow_signature_fields add constraint signatureflow_same_document_signer foreign key(signer_id,document_id) references public.signatureflow_signers(id,document_id) on delete cascade;
alter table public.signatureflow_signature_fields add constraint signatureflow_field_bounds check(x+width<=1.00001 and y+height<=1.00001);

-- Freeze issued envelopes at the database layer, including direct Data API calls.
drop policy if exists "signatureflow owner documents all" on public.signatureflow_documents;
create policy signatureflow_documents_read on public.signatureflow_documents for select to authenticated using(owner_id=(select auth.uid()));
create policy signatureflow_documents_create on public.signatureflow_documents for insert to authenticated with check(owner_id=(select auth.uid()) and status='draft' and storage_path=owner_id::text||'/'||id::text||'/original.pdf' and current_storage_path=storage_path);
create policy signatureflow_documents_edit on public.signatureflow_documents for update to authenticated using(owner_id=(select auth.uid()) and status='draft') with check(owner_id=(select auth.uid()) and status='draft');
create policy signatureflow_documents_delete on public.signatureflow_documents for delete to authenticated using(owner_id=(select auth.uid()) and status='draft');
revoke insert,update on public.signatureflow_documents from authenticated;
grant insert(id,owner_id,name,storage_path,current_storage_path,page_count,original_sha256,current_sha256,source_ref,signing_mode) on public.signatureflow_documents to authenticated;
grant update(name,source_ref,signing_mode) on public.signatureflow_documents to authenticated;
drop policy if exists "signatureflow owner signers all" on public.signatureflow_signers;
create policy signatureflow_signers_read on public.signatureflow_signers for select to authenticated using(exists(select 1 from public.signatureflow_documents d where d.id=document_id and d.owner_id=(select auth.uid())));
create policy signatureflow_signers_edit on public.signatureflow_signers for all to authenticated using(exists(select 1 from public.signatureflow_documents d where d.id=document_id and d.owner_id=(select auth.uid()) and d.status='draft')) with check(exists(select 1 from public.signatureflow_documents d where d.id=document_id and d.owner_id=(select auth.uid()) and d.status='draft'));
revoke insert,update on public.signatureflow_signers from authenticated;
grant insert(id,document_id,name,email,signing_order,role),update(name,email,signing_order,role) on public.signatureflow_signers to authenticated;
drop policy if exists "signatureflow owner fields all" on public.signatureflow_signature_fields;
create policy signatureflow_fields_read on public.signatureflow_signature_fields for select to authenticated using(exists(select 1 from public.signatureflow_documents d where d.id=document_id and d.owner_id=(select auth.uid())));
create policy signatureflow_fields_edit on public.signatureflow_signature_fields for all to authenticated using(exists(select 1 from public.signatureflow_documents d where d.id=document_id and d.owner_id=(select auth.uid()) and d.status='draft')) with check(exists(select 1 from public.signatureflow_documents d where d.id=document_id and d.owner_id=(select auth.uid()) and d.status='draft'));

-- Revoke browser changes to stored PDFs once links have been issued.
drop policy if exists "signatureflow documents owner insert" on storage.objects;
drop policy if exists "signatureflow documents owner update" on storage.objects;
drop policy if exists "signatureflow documents owner delete" on storage.objects;
create policy signatureflow_original_insert on storage.objects for insert to authenticated with check(bucket_id='signatureflow-documents' and exists(select 1 from public.signatureflow_documents d where d.storage_path=name and d.owner_id=(select auth.uid()) and d.status='draft'));
create policy signatureflow_original_delete on storage.objects for delete to authenticated using(bucket_id='signatureflow-documents' and exists(select 1 from public.signatureflow_documents d where d.storage_path=name and d.owner_id=(select auth.uid()) and d.status='draft'));
update storage.buckets set file_size_limit=20971520,allowed_mime_types=array['application/pdf'] where id='signatureflow-documents';

-- All browser mutations lock the parent row. This serializes them with issue/claim.
create function public.signatureflow_guard_draft() returns trigger language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents;
begin
 if current_user in ('authenticated','anon') then
  select * into d from public.signatureflow_documents where id=case when TG_OP='DELETE' then old.document_id else new.document_id end for update;
  if d.id is null or d.owner_id<>auth.uid() or d.status<>'draft' then raise exception 'Document verrouillé'; end if;
 end if;
 if TG_OP='DELETE' then return old; else return new; end if;
end;$$;
create trigger signatureflow_guard_signers before insert or update or delete on public.signatureflow_signers for each row execute function public.signatureflow_guard_draft();
create trigger signatureflow_guard_fields before insert or update or delete on public.signatureflow_signature_fields for each row execute function public.signatureflow_guard_draft();

-- Atomic replacement: invalid data rolls back the deletion too.
create function public.signatureflow_save_fields(p_document uuid,p_fields jsonb) returns void language plpgsql security invoker set search_path='' as $$
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
end;$$;
revoke all on function public.signatureflow_save_fields(uuid,jsonb) from public,anon;
grant execute on function public.signatureflow_save_fields(uuid,jsonb) to authenticated;

-- Service-only RPCs. No SECURITY DEFINER / no public token access through SQL.
create function public.signatureflow_issue(p_document uuid,p_owner uuid,p_links jsonb,p_hash text,p_pages int,p_manifest jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents; recipient_row record; link_value jsonb;
begin
 select * into d from public.signatureflow_documents where id=p_document for update;
 if d.id is null or d.owner_id<>p_owner or d.status not in ('draft','in_progress') then raise exception 'Dossier indisponible'; end if;
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
 insert into public.signatureflow_audit_events(document_id,event_type,metadata) values(p_document,'links_issued',jsonb_build_object('expires_days',14,'mode',d.signing_mode));
end;$$;

create function public.signatureflow_claim(p_hash text,p_request uuid,p_lease uuid,p_expected text) returns jsonb language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents; s public.signatureflow_signers;
begin
 select * into s from public.signatureflow_signers where token_hash=p_hash;
 if s.id is null or s.token_expires_at is null or s.token_expires_at<now() then raise exception 'Lien invalide ou expiré'; end if;
 select * into d from public.signatureflow_documents where id=s.document_id for update;
 select * into s from public.signatureflow_signers where id=s.id for update;
 if s.token_hash is distinct from p_hash then raise exception 'Lien remplacé'; end if;
 if s.status='signed' then return jsonb_build_object('alreadySigned',true,'sha256',s.result_sha256); end if;
 if d.status<>'in_progress' or s.status='cancelled' then raise exception 'Dossier indisponible'; end if;
 if d.current_sha256 is distinct from p_expected then raise exception 'Le document a changé. Relisez sa dernière version avant de signer.'; end if;
 if d.signing_mode='sequential' and exists(select 1 from public.signatureflow_signers where document_id=d.id and signing_order<s.signing_order and status<>'signed') then raise exception 'Un signataire précédent doit signer'; end if;
 if d.lock_until>now() then raise exception 'Une signature est en cours. Réessayez dans quelques instants.'; end if;
 update public.signatureflow_signers set status='pending' where document_id=d.id and status='signing';
 update public.signatureflow_documents set lock_id=p_lease,lock_until=now()+interval '3 minutes' where id=d.id;
 update public.signatureflow_signers set status='signing',request_id=p_request where id=s.id;
 return jsonb_build_object('document',to_jsonb(d),'signer',to_jsonb(s),'fields',(select jsonb_agg(to_jsonb(f) order by page,id) from public.signatureflow_signature_fields f where f.signer_id=s.id));
end;$$;

create function public.signatureflow_finish(p_document uuid,p_signer uuid,p_lease uuid,p_path text,p_source text,p_final text,p_name text,p_signed_at timestamptz,p_metadata jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents;
begin
 select * into d from public.signatureflow_documents where id=p_document for update;
 if d.lock_id is distinct from p_lease or d.lock_until<now() or d.status<>'in_progress' or d.current_sha256 is distinct from p_source then raise exception 'Verrou expiré. Réessayez après actualisation.'; end if;
 update public.signatureflow_signers set status='signed',typed_name=p_name,signed_at=p_signed_at,result_sha256=p_final where id=p_signer and document_id=p_document and status='signing';
 if not found then raise exception 'Signataire indisponible'; end if;
 update public.signatureflow_documents set current_storage_path=p_path,current_sha256=p_final,revision=revision+1,lock_id=null,lock_until=null,updated_at=now(),status=case when exists(select 1 from public.signatureflow_signers where document_id=p_document and status<>'signed') then 'in_progress' else 'signed' end where id=p_document;
 insert into public.signatureflow_audit_events(document_id,signer_id,event_type,metadata) values(p_document,p_signer,'document_signed',p_metadata||jsonb_build_object('source_sha256',p_source,'final_sha256',p_final,'signed_at',p_signed_at,'typed_name',p_name,'consent_version','2026-11-v2'));
end;$$;
create function public.signatureflow_release(p_document uuid,p_signer uuid,p_lease uuid) returns void language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.signatureflow_documents where id=p_document and lock_id=p_lease for update;
 if found then
  update public.signatureflow_signers set status='pending' where id=p_signer and status='signing';
  update public.signatureflow_documents set lock_id=null,lock_until=null where id=p_document and lock_id=p_lease;
 end if;
end;$$;
create function public.signatureflow_cancel(p_document uuid,p_owner uuid) returns void language plpgsql security invoker set search_path='' as $$
declare d public.signatureflow_documents;
begin
 select * into d from public.signatureflow_documents where id=p_document for update;
 if d.owner_id is distinct from p_owner or d.status='signed' then raise exception 'Annulation impossible'; end if;
 if d.lock_until>now() then raise exception 'Signature en cours'; end if;
 update public.signatureflow_documents set status='cancelled',updated_at=now() where id=p_document;
 update public.signatureflow_signers set status='cancelled',token_hash=null where document_id=p_document and status<>'signed';
 insert into public.signatureflow_audit_events(document_id,event_type) values(p_document,'document_cancelled');
end;$$;
revoke all on function public.signatureflow_issue(uuid,uuid,jsonb,text,int,jsonb),public.signatureflow_claim(text,uuid,uuid,text),public.signatureflow_finish(uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb),public.signatureflow_release(uuid,uuid,uuid),public.signatureflow_cancel(uuid,uuid) from public,anon,authenticated;
grant execute on function public.signatureflow_issue(uuid,uuid,jsonb,text,int,jsonb),public.signatureflow_claim(text,uuid,uuid,text),public.signatureflow_finish(uuid,uuid,uuid,text,text,text,text,timestamptz,jsonb),public.signatureflow_release(uuid,uuid,uuid),public.signatureflow_cancel(uuid,uuid) to service_role;
