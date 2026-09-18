import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1'
import { corsHeaders, json, adminClient, sha256Text, sha256Bytes } from '../_shared/common.ts'

function dataUrlToBytes(dataUrl: string) {
  const base64 = dataUrl.split(',')[1]
  if (!base64) throw new Error('Invalid signature image')
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const admin = adminClient()
  let signerId: string | null = null
  try {
    const { token, typedName, accepted, signatureDataUrl } = await req.json()
    if (!token || !typedName || accepted !== true || !signatureDataUrl) return json({ error: 'Incomplete signature request' }, 400)
    if (signatureDataUrl.length > 2_500_000) return json({ error: 'Signature image too large' }, 413)

    const tokenHash = await sha256Text(token)
    const { data: signer } = await admin.from('signatureflow_signers').select('*').eq('token_hash', tokenHash).single()
    if (!signer) return json({ error: 'Invalid link' }, 404)
    signerId = signer.id
    if (signer.status === 'signed') return json({ ok: true, alreadySigned: true })
    if (signer.status !== 'pending') return json({ error: 'Signature already being processed' }, 409)
    if (!signer.token_expires_at || new Date(signer.token_expires_at) < new Date()) return json({ error: 'Expired link' }, 410)

    const { data: previous } = await admin.from('signatureflow_signers').select('id,status').eq('document_id', signer.document_id).lt('signing_order', signer.signing_order)
    if ((previous || []).some(s => s.status !== 'signed')) return json({ error: 'Previous signer has not signed yet' }, 409)

    const { data: lockRows } = await admin.from('signatureflow_signers').update({ status: 'signing' }).eq('id', signer.id).eq('status', 'pending').select('id')
    if (!lockRows?.length) return json({ error: 'Signature already being processed' }, 409)

    const { data: doc } = await admin.from('signatureflow_documents').select('*').eq('id', signer.document_id).single()
    const { data: fields } = await admin.from('signatureflow_signature_fields').select('*').eq('document_id', signer.document_id).eq('signer_id', signer.id)
    if (!doc || !fields?.length) throw new Error('No signature field configured')

    const sourcePath = doc.current_storage_path || doc.storage_path
    const { data: sourceBlob, error: dlError } = await admin.storage.from('signatureflow-documents').download(sourcePath)
    if (dlError) throw dlError
    const sourceBytes = new Uint8Array(await sourceBlob.arrayBuffer())
    const sourceHash = await sha256Bytes(sourceBytes)
    const pdf = await PDFDocument.load(sourceBytes)
    const signature = await pdf.embedPng(dataUrlToBytes(signatureDataUrl))
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const signedAt = new Date()
    const signedAtLabel = signedAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })

    for (const field of fields) {
      const page = pdf.getPage(Number(field.page) - 1)
      const { width: pw, height: ph } = page.getSize()
      const x = Number(field.x) * pw
      const y = ph - (Number(field.y) + Number(field.height)) * ph
      const w = Number(field.width) * pw
      const h = Number(field.height) * ph
      const pad = Math.max(2, h * .08)
      page.drawImage(signature, { x: x + pad, y: y + h * .26, width: w - pad * 2, height: h * .68 })
      const label = `${typedName} · ${signer.email} · ${signedAtLabel}`
      const fontSize = Math.max(5, Math.min(8, h * .11))
      page.drawText(label.slice(0, 120), { x: x + pad, y: y + pad, size: fontSize, font, color: rgb(.15,.15,.18), maxWidth: w - pad * 2 })
    }

    const finalBytes = new Uint8Array(await pdf.save())
    const finalHash = await sha256Bytes(finalBytes)
    const finalPath = `${doc.owner_id}/${doc.id}/signed-${Date.now()}.pdf`
    const { error: upError } = await admin.storage.from('signatureflow-documents').upload(finalPath, finalBytes, { contentType: 'application/pdf', upsert: false })
    if (upError) throw upError

    await admin.from('signatureflow_documents').update({ current_storage_path: finalPath, updated_at: new Date().toISOString() }).eq('id', doc.id)
    await admin.from('signatureflow_signers').update({ status: 'signed', signed_at: signedAt.toISOString(), typed_name: typedName, token_hash: null }).eq('id', signer.id)
    await admin.from('signatureflow_audit_events').insert({ document_id: doc.id, signer_id: signer.id, event_type: 'document_signed', metadata: { email: signer.email, typed_name: typedName, consent: true, signed_at: signedAt.toISOString(), source_sha256: sourceHash, final_sha256: finalHash, user_agent: req.headers.get('user-agent') || null } })

    const { data: remaining } = await admin.from('signatureflow_signers').select('id,status').eq('document_id', doc.id).neq('status', 'signed')
    if (!remaining?.length) await admin.from('signatureflow_documents').update({ status: 'signed', updated_at: new Date().toISOString() }).eq('id', doc.id)
    else await admin.from('signatureflow_documents').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', doc.id)

    return json({ ok: true, sha256: finalHash })
  } catch (e) {
    if (signerId) await admin.from('signatureflow_signers').update({ status: 'pending' }).eq('id', signerId).eq('status', 'signing')
    return json({ error: e?.message || 'Server error' }, 500)
  }
})
