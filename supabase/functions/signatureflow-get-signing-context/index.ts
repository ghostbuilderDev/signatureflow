import { corsHeaders, json, adminClient, sha256Text } from '../_shared/common.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const { token } = await req.json()
    if (!token) return json({ error: 'token required' }, 400)
    const tokenHash = await sha256Text(token)
    const admin = adminClient()
    const { data: signer } = await admin.from('signatureflow_signers').select('*').eq('token_hash', tokenHash).single()
    if (!signer) return json({ error: 'Invalid link' }, 404)
    if (!signer.token_expires_at || new Date(signer.token_expires_at) < new Date()) return json({ error: 'Expired link' }, 410)

    const { data: doc } = await admin.from('signatureflow_documents').select('*').eq('id', signer.document_id).single()
    if (!doc) return json({ error: 'Document not found' }, 404)

    const { data: previous } = await admin.from('signatureflow_signers').select('id,status').eq('document_id', doc.id).lt('signing_order', signer.signing_order)
    const blocked = (previous || []).some(s => s.status !== 'signed')
    if (blocked) return json({ blocked: true, signer: { name: signer.name, email: signer.email, status: signer.status } })

    const { data: fields } = await admin.from('signatureflow_signature_fields').select('*').eq('document_id', doc.id).eq('signer_id', signer.id).order('page')
    const path = doc.current_storage_path || doc.storage_path
    const { data: signed, error: urlError } = await admin.storage.from('signatureflow-documents').createSignedUrl(path, 900)
    if (urlError) throw urlError

    await admin.from('signatureflow_audit_events').insert({ document_id: doc.id, signer_id: signer.id, event_type: 'document_opened', metadata: { user_agent: req.headers.get('user-agent') || null } })
    return json({
      blocked: false,
      signer: { name: signer.name, email: signer.email, status: signer.status },
      document: { name: doc.name, signedUrl: signed.signedUrl },
      fields: fields || []
    })
  } catch (e) {
    return json({ error: e?.message || 'Server error' }, 500)
  }
})
