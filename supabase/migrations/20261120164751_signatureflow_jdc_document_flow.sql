alter table public.signatureflow_documents add column sf3_managed boolean not null default false, add column sf3_chantier_id uuid references public.chantiers(id);
create policy sf3_managed_document_guard on public.signatureflow_documents as restrictive for all to authenticated
 using(not sf3_managed or sf3_chantier_id is null or public.journal_can_manage_chantier_documents(sf3_chantier_id))
 with check(not sf3_managed or sf3_chantier_id is null or public.journal_can_manage_chantier_documents(sf3_chantier_id));
-- Additive module. Existing SignatureFlow envelopes and JDC documents are retained.
create table public.sf3_documents (
 id uuid primary key, owner_id uuid not null references auth.users(id),
 chantier_id uuid references public.chantiers(id), folder_id uuid references public.chantier_document_folders(id),
 title text not null check(length(title) between 1 and 200),
 document_type text not null check(document_type in ('CSF','ISF','PPSPS','PARTICULARITES','AUTRE')),
 current_version_id uuid, created_at timestamptz not null default now(),
 check ((chantier_id is null)=(folder_id is null))
);
create table public.sf3_versions (
 id uuid primary key, document_id uuid not null references public.sf3_documents(id),
 label text not null check(length(label) between 1 and 60), change_summary text not null default '',
 effective_at timestamptz, previous_id uuid references public.sf3_versions(id),
 linked_csf_version_id uuid references public.sf3_versions(id),
 source_document_id uuid references public.chantier_documents(id),
 source_path text not null unique, source_sha256 text check(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_pages int check(source_pages between 1 and 190), source_bytes bigint,
 state text not null default 'uploading' check(state in ('uploading','draft','current','superseded')),
 created_at timestamptz not null default now(), unique(document_id,label),
 check(state='uploading' or (source_sha256 is not null and source_pages is not null))
);
alter table public.sf3_documents add constraint sf3_current_version foreign key(current_version_id) references public.sf3_versions(id);
create table public.sf3_campaigns (
 id uuid primary key, version_id uuid not null references public.sf3_versions(id), owner_id uuid not null references auth.users(id),
 mode text not null check(mode in ('application','acknowledgement')),
 deadline timestamptz, copies text[] not null default '{}', reminder_hours int not null default 48 check(reminder_hours between 12 and 720),
 created_at timestamptz not null default now()
);
create table public.sf3_envelopes (
 envelope_id uuid primary key references public.signatureflow_documents(id), campaign_id uuid not null references public.sf3_campaigns(id),
 annex_start int not null default 0, created_at timestamptz not null default now()
);
create table public.sf3_recipients (
 signer_id uuid primary key references public.signatureflow_signers(id), envelope_id uuid not null references public.sf3_envelopes(envelope_id),
 campaign_id uuid not null references public.sf3_campaigns(id), user_id uuid references auth.users(id), company text not null default '',
 link_cipher text, opened_at timestamptz, invited_at timestamptz, last_reminded_at timestamptz,
 email_status text not null default 'pending', unique(campaign_id,signer_id)
);
create index sf3_recipients_user on public.sf3_recipients(user_id);
create index sf3_campaigns_version on public.sf3_campaigns(version_id);
create index sf3_documents_site on public.sf3_documents(chantier_id);
create table public.sf3_jobs (
 id uuid primary key default gen_random_uuid(), job_key text not null unique,
 kind text not null check(kind in ('invitation','receipt','archive','final_copy','reminder')),
 version_id uuid not null references public.sf3_versions(id), signer_id uuid references public.signatureflow_signers(id),
 payload jsonb not null default '{}', status text not null default 'pending' check(status in ('pending','running','done','error')),
 attempts int not null default 0, available_at timestamptz not null default now(), lease_id uuid, lease_until timestamptz,
 last_error text, resend_id text unique, delivered_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index sf3_jobs_ready on public.sf3_jobs(status,available_at);
create table public.sf3_archives (
 id uuid primary key, version_id uuid not null references public.sf3_versions(id), fingerprint text not null,
 storage_bucket text not null, storage_path text not null, sha256 text not null, signed_count int not null, expected_count int not null,
 complete boolean not null, jdc_document_id uuid references public.chantier_documents(id), created_at timestamptz not null default now(),
 unique(version_id,fingerprint)
);
create table public.sf3_events (
 id bigint generated always as identity primary key, version_id uuid not null references public.sf3_versions(id),
 actor_id uuid, event_type text not null, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
create table public.sf3_webhooks (event_id text primary key, email_id text not null, state text not null, received_at timestamptz not null default now());
-- Every new table is service-only. All user actions go through the authenticated Edge API.
do $$declare n text;begin
 foreach n in array array['sf3_documents','sf3_versions','sf3_campaigns','sf3_envelopes','sf3_recipients','sf3_jobs','sf3_archives','sf3_events','sf3_webhooks'] loop
  execute format('alter table public.%I enable row level security',n);
  execute format('revoke all on public.%I from public,anon,authenticated',n);
  execute format('grant select,insert,update,delete on public.%I to service_role',n);
 end loop;
end;$$;
grant usage,select on sequence public.sf3_events_id_seq to service_role;

create function public.sf3_publish_version(p_version uuid,p_expected uuid,p_actor uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare v public.sf3_versions; d public.sf3_documents; b record;
begin
 select * into v from public.sf3_versions where id=p_version;
 select * into d from public.sf3_documents where id=v.document_id for update;
 if d.id is null or v.state not in ('draft','current') then raise exception 'Version non publiable'; end if;
 if d.current_version_id=v.id then return; end if;
 if d.current_version_id is distinct from p_expected then raise exception 'La version courante a changé. Actualisez.'; end if;
 if v.linked_csf_version_id is not null and not exists(
  select 1 from public.sf3_versions cv join public.sf3_documents cd on cd.id=cv.document_id
  where cv.id=v.linked_csf_version_id and cd.document_type='CSF' and cd.chantier_id is not distinct from d.chantier_id
   and (cd.chantier_id is not null or cd.owner_id=d.owner_id) and cv.state='current'
 ) then raise exception 'La CSF liée doit être la version courante du même chantier'; end if;
 -- Lock the same envelope rows as signatureflow_claim. Never replace a version during a signature lease.
 for b in select sd.id,sd.lock_until from public.signatureflow_documents sd join public.sf3_envelopes e on e.envelope_id=sd.id
  join public.sf3_campaigns c on c.id=e.campaign_id where c.version_id=d.current_version_id for update of sd loop
  if b.lock_until>now() then raise exception 'Une signature est en cours. Réessayez après son enregistrement.'; end if;
 end loop;
 if d.current_version_id is not null and d.current_version_id<>v.id then
  update public.sf3_versions set state='superseded' where id=d.current_version_id;
  update public.signatureflow_documents sd set status='cancelled',updated_at=now()
   from public.sf3_envelopes e,public.sf3_campaigns c where e.envelope_id=sd.id and c.id=e.campaign_id
    and c.version_id=d.current_version_id and sd.status in ('draft','in_progress');
  update public.signatureflow_signers s set token_hash=null,status='cancelled'
   from public.sf3_envelopes e,public.sf3_campaigns c where e.envelope_id=s.document_id and c.id=e.campaign_id
    and c.version_id=d.current_version_id and s.status<>'signed';
  insert into public.sf3_jobs(job_key,kind,version_id) values('superseded:'||d.current_version_id,'archive',d.current_version_id) on conflict(job_key) do nothing;
 end if;
 update public.sf3_versions set state='current',previous_id=coalesce(previous_id,d.current_version_id) where id=v.id;
 update public.sf3_documents set current_version_id=v.id where id=d.id;
 insert into public.sf3_events(version_id,actor_id,event_type,metadata) values(v.id,p_actor,'version_published',jsonb_build_object('previous',d.current_version_id));
end;$$;

create function public.sf3_register_campaign(p_campaign jsonb,p_envelopes jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare v public.sf3_versions; d public.sf3_documents; item jsonb; recipient jsonb; cid uuid:=(p_campaign->>'id')::uuid;
begin
 select * into v from public.sf3_versions where id=(p_campaign->>'version_id')::uuid for update;
 select * into d from public.sf3_documents where id=v.document_id for update;
 if v.state<>'current' or d.current_version_id<>v.id then raise exception 'Cette version n’est plus courante'; end if;
 if exists(select 1 from public.sf3_campaigns where id=cid) then return; end if;
 if p_campaign->>'mode'='application' and exists(
  select 1 from public.sf3_campaigns c join public.sf3_envelopes e on e.campaign_id=c.id
  join public.signatureflow_documents sd on sd.id=e.envelope_id where c.version_id=v.id
   and (c.mode='acknowledgement' or sd.status in ('draft','in_progress'))
 ) then raise exception 'Terminez les signatures d’application avant la diffusion pour prise de connaissance'; end if;
 if p_campaign->>'mode'='acknowledgement' and exists(
  select 1 from public.sf3_campaigns c join public.sf3_envelopes e on e.campaign_id=c.id
  join public.signatureflow_documents sd on sd.id=e.envelope_id where c.version_id=v.id and c.mode='application' and sd.status<>'signed'
 ) then raise exception 'Les signatures d’application ne sont pas terminées'; end if;
 insert into public.sf3_campaigns(id,version_id,owner_id,mode,deadline,copies,reminder_hours)
 values(cid,v.id,(p_campaign->>'owner_id')::uuid,p_campaign->>'mode',(p_campaign->>'deadline')::timestamptz,
  array(select jsonb_array_elements_text(coalesce(p_campaign->'copies','[]'))),coalesce((p_campaign->>'reminder_hours')::int,48));
 for item in select value from jsonb_array_elements(p_envelopes) loop
  insert into public.signatureflow_documents(id,owner_id,name,storage_path,current_storage_path,page_count,source_ref,workflow_type,completion_mode,require_full_read,identity_stamp,prepared_at,sf3_managed,sf3_chantier_id,original_sha256,current_sha256)
  values((item->>'id')::uuid,(p_campaign->>'owner_id')::uuid,item->>'name',item->>'path',item->>'path',(item->>'pages')::int,
   'sf3:'||v.id::text||':'||cid::text,case when p_campaign->>'mode'='acknowledgement' then 'acknowledgement' else 'approval' end,
   'manual',coalesce((p_campaign->>'require_full_read')::boolean,true),true,null,true,d.chantier_id,item->>'sha256',item->>'sha256');
  insert into public.sf3_envelopes(envelope_id,campaign_id,annex_start) values((item->>'id')::uuid,cid,coalesce((item->>'annex_start')::int,0));
  for recipient in select value from jsonb_array_elements(item->'signers') loop
   insert into public.signatureflow_signers(id,document_id,name,email,role,signing_order)
   values((recipient->>'id')::uuid,(item->>'id')::uuid,recipient->>'name',recipient->>'email',recipient->>'role',(recipient->>'order')::int);
   insert into public.sf3_recipients(signer_id,envelope_id,campaign_id,user_id,company)
   values((recipient->>'id')::uuid,(item->>'id')::uuid,cid,(recipient->>'user_id')::uuid,coalesce(recipient->>'company',''));
  end loop;
  insert into public.signatureflow_signature_fields(id,document_id,signer_id,page,x,y,width,height,kind,label,required)
  select (f->>'id')::uuid,(item->>'id')::uuid,(f->>'signer_id')::uuid,(f->>'page')::int,(f->>'x')::numeric,(f->>'y')::numeric,
   (f->>'width')::numeric,(f->>'height')::numeric,coalesce(f->>'kind','signature'),coalesce(f->>'label','Signature'),true
  from jsonb_array_elements(coalesce(item->'fields','[]')) f;
 end loop;
 insert into public.sf3_events(version_id,actor_id,event_type,metadata)
 values(v.id,(p_campaign->>'owner_id')::uuid,'campaign_prepared',jsonb_build_object('campaign',cid,'mode',p_campaign->>'mode'));
end;$$;

create function public.sf3_track_signing() returns trigger language plpgsql security invoker set search_path='' as $$
declare vid uuid;
begin
 if new.status='signed' and old.status is distinct from 'signed' then
  select c.version_id into vid from public.sf3_envelopes e join public.sf3_campaigns c on c.id=e.campaign_id where e.envelope_id=new.document_id;
  if vid is not null then
   insert into public.sf3_jobs(job_key,kind,version_id,signer_id) values('receipt:'||new.id,'receipt',vid,new.id) on conflict(job_key) do nothing;
   insert into public.sf3_jobs(job_key,kind,version_id) values('archive:'||new.id,'archive',vid) on conflict(job_key) do nothing;
   insert into public.sf3_events(version_id,event_type,metadata) values(vid,'signature_registered',jsonb_build_object('signer_id',new.id,'signed_at',new.signed_at));
  end if;
 end if;
 return new;
end;$$;
create trigger sf3_signature_registered after update on public.signatureflow_signers for each row execute function public.sf3_track_signing();

create function public.sf3_capture_invites(p_envelope uuid,p_links jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare vid uuid; item jsonb;
begin
 select c.version_id into vid from public.sf3_envelopes e join public.sf3_campaigns c on c.id=e.campaign_id where e.envelope_id=p_envelope;
 if vid is null then raise exception 'Dossier non rattaché'; end if;
 for item in select value from jsonb_array_elements(p_links) loop
  update public.sf3_recipients set link_cipher=item->>'cipher',invited_at=now(),email_status='pending'
   where signer_id=(item->>'id')::uuid and envelope_id=p_envelope;
  if not found then raise exception 'Destinataire invalide'; end if;
  insert into public.sf3_jobs(job_key,kind,version_id,signer_id,payload)
   values('invite:'||(item->>'id')||':'||(item->>'hash'),'invitation',vid,(item->>'id')::uuid,jsonb_build_object('cipher',item->>'cipher'))
   on conflict(job_key) do nothing;
 end loop;
end;$$;

create function public.sf3_claim_jobs(p_lease uuid,p_limit int default 5,p_version uuid default null) returns setof public.sf3_jobs
language sql security invoker set search_path='' as $$
 update public.sf3_jobs set status='running',lease_id=p_lease,lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
 where id in (select id from public.sf3_jobs where available_at<=now() and attempts<10
  and (status in ('pending','error') or (status='running' and lease_until<now()))
  and (p_version is null or version_id=p_version) order by created_at limit least(greatest(p_limit,1),20) for update skip locked)
 returning *;
$$;

create function public.sf3_record_archive(p_archive jsonb,p_document jsonb default null) returns uuid
language plpgsql security invoker set search_path='' as $$
declare aid uuid; v public.sf3_versions; expected jsonb;
begin
 select * into v from public.sf3_versions where id=(p_archive->>'version_id')::uuid for update;
 -- Lock the envelope rows used by signatureflow_finish; refuse an outdated snapshot.
 perform 1 from public.signatureflow_documents sd join public.sf3_envelopes e on e.envelope_id=sd.id
 join public.sf3_campaigns c on c.id=e.campaign_id where c.version_id=v.id for update of sd;
 select coalesce(jsonb_agg(jsonb_build_object('id',sd.id,'sha256',coalesce(sd.current_sha256,''),'status',sd.status) order by sd.id),'[]') into expected
 from public.signatureflow_documents sd join public.sf3_envelopes e on e.envelope_id=sd.id
 join public.sf3_campaigns c on c.id=e.campaign_id where c.version_id=v.id and (sd.status<>'cancelled' or exists(select 1 from public.signatureflow_signers s where s.document_id=sd.id and s.status='signed'));
 if expected is distinct from p_archive->'snapshot' then raise exception 'Le suivi a évolué pendant le classement. Le traitement sera relancé.'; end if;
 select id into aid from public.sf3_archives where version_id=v.id and fingerprint=p_archive->>'fingerprint';
 if aid is not null then return aid; end if;
 aid:=(p_archive->>'id')::uuid;
 if p_document is not null then
  insert into public.chantier_documents(id,chantier_id,folder_id,storage_path,file_name,mime_type,bytes,description,version_label,created_by,created_by_name)
  values(aid,(p_document->>'chantier_id')::uuid,(p_document->>'folder_id')::uuid,p_archive->>'storage_path',p_document->>'file_name',
   'application/pdf',(p_document->>'bytes')::bigint,p_document->>'description',v.label,(p_document->>'owner_id')::uuid,'SignatureFlow');
 end if;
 insert into public.sf3_archives(id,version_id,fingerprint,storage_bucket,storage_path,sha256,signed_count,expected_count,complete,jdc_document_id)
 values(aid,v.id,p_archive->>'fingerprint',p_archive->>'storage_bucket',p_archive->>'storage_path',p_archive->>'sha256',
  (p_archive->>'signed_count')::int,(p_archive->>'expected_count')::int,(p_archive->>'complete')::boolean,case when p_document is null then null else aid end);
 insert into public.sf3_events(version_id,event_type,metadata) values(v.id,'archive_created',p_archive-'storage_path');
 return aid;
end;$$;
-- Service-only RPCs. No new SECURITY DEFINER functions and no browser access to tokens/jobs.
revoke all on function public.sf3_publish_version(uuid,uuid,uuid),public.sf3_register_campaign(jsonb,jsonb),public.sf3_capture_invites(uuid,jsonb),public.sf3_claim_jobs(uuid,int,uuid),public.sf3_record_archive(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sf3_publish_version(uuid,uuid,uuid),public.sf3_register_campaign(jsonb,jsonb),public.sf3_capture_invites(uuid,jsonb),public.sf3_claim_jobs(uuid,int,uuid),public.sf3_record_archive(jsonb,jsonb) to service_role;
revoke all on function public.sf3_track_signing() from public,anon,authenticated;

create function public.sf3_schedule_reminders(p_version uuid default null) returns int
language plpgsql security invoker set search_path='' as $$
declare added int;
begin
 insert into public.sf3_jobs(job_key,kind,version_id,signer_id,payload)
 select 'reminder:'||r.signer_id||':'||floor(extract(epoch from now())/(c.reminder_hours*3600))::text,
  'reminder',c.version_id,r.signer_id,jsonb_build_object('cipher',r.link_cipher)
 from public.sf3_recipients r join public.sf3_campaigns c on c.id=r.campaign_id
 join public.sf3_versions v on v.id=c.version_id join public.signatureflow_signers s on s.id=r.signer_id
 join public.signatureflow_documents d on d.id=r.envelope_id
 where (p_version is null or v.id=p_version) and v.state='current' and d.status='in_progress'
  and s.status='pending' and s.token_expires_at>now() and r.link_cipher is not null
  and coalesce(r.last_reminded_at,r.invited_at)+make_interval(hours=>c.reminder_hours)<=now()
 on conflict(job_key) do nothing;
 get diagnostics added=row_count;return added;
end;$$;
create function public.sf3_apply_delivery(p_email_id text) returns void
language plpgsql security invoker set search_path='' as $$
declare job public.sf3_jobs; delivery public.sf3_webhooks;
begin
 select * into job from public.sf3_jobs where resend_id=p_email_id for update;
 if job.id is null then return; end if;
 select * into delivery from public.sf3_webhooks where email_id=p_email_id order by received_at desc,event_id desc limit 1;
 if delivery.event_id is null then return; end if;
 update public.sf3_jobs set delivered_at=case when delivery.state='delivered' then coalesce(delivered_at,delivery.received_at) else delivered_at end,
  payload=payload||jsonb_build_object('email_state',delivery.state),updated_at=now() where id=job.id;
 if job.kind in ('invitation','reminder') then update public.sf3_recipients set email_status=delivery.state where signer_id=job.signer_id; end if;
end;$$;
create function public.sf3_resend_event(p_event_id text,p_email_id text,p_state text) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if p_state not in ('delivered','bounced','complained','failed') or nullif(p_email_id,'') is null then raise exception 'Evenement inconnu'; end if;
 insert into public.sf3_webhooks(event_id,email_id,state) values(p_event_id,p_email_id,p_state) on conflict(event_id) do nothing;
 if not found then return; end if;
 perform public.sf3_apply_delivery(p_email_id);
end;$$;
revoke all on function public.sf3_apply_delivery(text) from public,anon,authenticated;
grant execute on function public.sf3_apply_delivery(text) to service_role;
create function public.sf3_track_opening() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.event_type='document_opened' then update public.sf3_recipients set opened_at=coalesce(opened_at,now()) where signer_id=new.signer_id; end if;
 return new;
end;$$;
create trigger sf3_document_opened after insert on public.signatureflow_audit_events for each row execute function public.sf3_track_opening();
revoke all on function public.sf3_schedule_reminders(uuid),public.sf3_resend_event(text,text,text),public.sf3_track_opening() from public,anon,authenticated;
grant execute on function public.sf3_schedule_reminders(uuid),public.sf3_resend_event(text,text,text) to service_role;

-- Link generation and durable dispatch are one transaction, including reissues.
create function public.sf3_issue(p_document uuid,p_owner uuid,p_links jsonb,p_hash text,p_pages int,p_manifest jsonb,p_encrypted jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if jsonb_array_length(p_links)<>jsonb_array_length(p_encrypted) or exists(select 1 from jsonb_array_elements(p_links) l where not exists(select 1 from jsonb_array_elements(p_encrypted) e where e->>'id'=l->>'id' and e->>'hash'=l->>'hash' and nullif(e->>'cipher','') is not null)) then raise exception 'Liens chiffrés incomplets'; end if;
 perform public.signatureflow_issue(p_document,p_owner,p_links,p_hash,p_pages,p_manifest);
 perform public.sf3_capture_invites(p_document,p_encrypted);
end;$$;
revoke all on function public.sf3_issue(uuid,uuid,jsonb,text,int,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sf3_issue(uuid,uuid,jsonb,text,int,jsonb,jsonb) to service_role;

create index sf3_jobs_version on public.sf3_jobs(version_id,created_at desc);
create index sf3_events_version on public.sf3_events(version_id,created_at desc);
create index sf3_pending_email on public.signatureflow_signers(email) where status in ('pending','signing');
