-- The deployed import explicitly sends status='draft'.
-- The existing INSERT RLS policy enforces ownership, draft status and PDF path.
-- Keep UPDATE(status) restricted to server-side operations.
grant insert(status) on table public.signatureflow_documents to authenticated;
