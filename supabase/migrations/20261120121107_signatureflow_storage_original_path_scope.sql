-- Qualify objects.name: unqualified name resolves to d.name in the subquery.
alter policy signatureflow_original_insert on storage.objects
with check (
 bucket_id='signatureflow-documents' and exists (
  select 1 from public.signatureflow_documents d
  where d.storage_path=objects.name
    and d.owner_id=(select auth.uid())
    and d.status='draft'
 )
);
alter policy signatureflow_original_delete on storage.objects
using (
 bucket_id='signatureflow-documents' and exists (
  select 1 from public.signatureflow_documents d
  where d.storage_path=objects.name
    and d.owner_id=(select auth.uid())
    and d.status='draft'
 )
);
