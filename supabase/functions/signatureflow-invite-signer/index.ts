import { corsHeaders, json, adminClient, requireUser, randomToken, sha256Text } from '../_shared/common.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const user = await requireUser(req)
    const { documentId, appUrl } = await req.json()
    if (!documentId) return json({ error: 'documentId required' }, 400)
    const admin = adminClient()

    const { data: doc } = await admin.from('signatureflow_documents').select('*').eq('id', documentId).single()
    if (!doc || doc.owner_id !== user.id) return json({ error: 'Forbidden' }, 403)

    const { data: signers } = await admin.from('signatureflow_signers').select('*').eq('document_id', documentId).order('signing_order')
    if (!signers?.length) return json({ error: 'No signers' }, 400)

    const resendKey = Deno.env.get('RESEND_API_KEY')
    const from = Deno.env.get('SIGNATUREFLOW_EMAIL_FROM') || Deno.env.get('EMAIL_FROM') || Deno.env.get('JOURNAL_CR_FROM') || 'SignatureFlow <onboarding@resend.dev>'
    const baseUrl = (Deno.env.get('APP_URL') || appUrl || '').replace(/\/$/, '') + '/'
    if (!resendKey || !baseUrl.startsWith('http')) return json({ error: 'RESEND_API_KEY / APP_URL missing' }, 500)

    let sent = 0
    for (const signer of signers) {
      if (signer.status === 'signed') continue
      const token = randomToken(32)
      const tokenHash = await sha256Text(token)
      const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString()
      await admin.from('signatureflow_signers').update({ token_hash: tokenHash, token_expires_at: expires, status: 'pending' }).eq('id', signer.id)
      const link = `${baseUrl}?sign=${encodeURIComponent(token)}`
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#111827">
          <h2>Document à signer</h2>
          <p>Bonjour ${signer.name},</p>
          <p>Le document <strong>${doc.name}</strong> est disponible pour lecture et signature.</p>
          <p><a href="${link}" style="display:inline-block;background:#0284c7;color:white;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Ouvrir et signer</a></p>
          <p style="font-size:12px;color:#6b7280">Ce lien est personnel et expire dans 14 jours. Ne le transférez pas.</p>
        </div>`
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
        body: JSON.stringify({ from, to: [signer.email], subject: `Signature requise — ${doc.name}`, html })
      })
      if (!res.ok) {
        const details = await res.text()
        await admin.from('signatureflow_audit_events').insert({ document_id: documentId, signer_id: signer.id, event_type: 'email_error', metadata: { details } })
        continue
      }
      sent++
      await admin.from('signatureflow_audit_events').insert({ document_id: documentId, signer_id: signer.id, event_type: 'invitation_sent', metadata: { email: signer.email, expires_at: expires } })
    }
    return json({ ok: true, sent })
  } catch (e) {
    return json({ error: e?.message || 'Server error' }, e?.message === 'UNAUTHORIZED' ? 401 : 500)
  }
})
