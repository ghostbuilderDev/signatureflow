import './style.css'
import { createClient } from '@supabase/supabase-js'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import SignaturePad from 'signature_pad'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const APP_URL = import.meta.env.VITE_APP_URL || window.location.href.split('?')[0]

const app = document.querySelector('#app')
const configured = SUPABASE_URL && SUPABASE_KEY && !SUPABASE_URL.includes('YOUR_')
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

const state = {
  session: null,
  documents: [],
  currentDoc: null,
  signers: [],
  fields: [],
  audit: [],
  pdf: null,
  pdfBytes: null,
  page: 1,
  scale: 1.35,
  placementSignerId: null,
  message: null,
}

const esc = (s='') => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))
const uid = () => crypto.randomUUID()

function layout(content, right='') {
  return `<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark">✍</div><span>SignatureFlow</span></div><div class="row">${right}</div></header>${content}</div>`
}

function render() {
  if (!configured) return renderSetupMissing()
  if (!state.session) return renderLogin()
  if (state.currentDoc) return renderEditor()
  return renderDashboard()
}

function flash(type, text) {
  state.message = { type, text }
  render()
  setTimeout(() => { state.message = null; render() }, 4500)
}

function messageHtml() {
  if (!state.message) return ''
  return `<div class="${state.message.type}">${esc(state.message.text)}</div>`
}

async function boot() {
  const urlToken = new URLSearchParams(location.search).get('sign')
  if (urlToken) {
    sessionStorage.setItem('signatureflow_sign_token', urlToken)
    history.replaceState({}, '', location.pathname)
  }
  const token = urlToken || sessionStorage.getItem('signatureflow_sign_token')
  if (token) return renderSigningPage(token)

  if (!configured) return renderSetupMissing()
  const { data } = await supabase.auth.getSession()
  state.session = data.session
  supabase.auth.onAuthStateChange((_event, session) => {
    state.session = session
    if (session) loadDocuments(); else renderLogin()
  })
  if (state.session) await loadDocuments(); else renderLogin()
}

function renderSetupMissing() {
  app.innerHTML = layout(`<main class="container"><div class="card auth"><h1>Configuration requise</h1><p class="muted">Copie <span class="kbd">.env.example</span> vers <span class="kbd">.env</span> et renseigne l’URL Supabase et la clé publique.</p><div class="warning">Aucune clé secrète Supabase ne doit être placée dans le navigateur.</div></div></main>`)
}

function renderLogin() {
  app.innerHTML = layout(`<main class="container"><div class="card auth stack"><div><h1>Connexion administrateur</h1><p class="muted">Reçois un lien de connexion sécurisé par e-mail.</p></div>${messageHtml()}<div class="field"><label>E-mail</label><input id="loginEmail" type="email" placeholder="prenom.nom@entreprise.fr"></div><button class="btn blue" id="loginBtn">Recevoir le lien de connexion</button></div></main>`)
  document.querySelector('#loginBtn').onclick = async () => {
    const email = document.querySelector('#loginEmail').value.trim()
    if (!email) return
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: APP_URL, shouldCreateUser: false } })
    if (error) return flash('error', error.message)
    flash('success', 'Lien de connexion envoyé par e-mail.')
  }
}

async function loadDocuments() {
  state.currentDoc = null
  const { data, error } = await supabase.from('signatureflow_documents').select('*').order('created_at', { ascending: false })
  if (error) return flash('error', error.message)
  state.documents = data || []
  renderDashboard()
}

function renderDashboard() {
  const docs = state.documents.map(d => `<div class="doc-item" data-id="${d.id}"><div class="row between"><strong>${esc(d.name)}</strong><span class="pill ${d.status==='signed'?'signed':'pending'}">${esc(d.status)}</span></div><div class="small muted">${new Date(d.created_at).toLocaleString('fr-FR')}</div></div>`).join('') || '<p class="muted">Aucun document.</p>'
  app.innerHTML = layout(`<main class="container grid grid-2"><section class="card stack"><div><h2>Nouveau document</h2><p class="muted">Importe un PDF, puis place automatiquement ou manuellement les zones de signature.</p></div>${messageHtml()}<div class="field"><label>Nom du dossier</label><input id="docName" placeholder="Ex. ISF Montereau S38"></div><div class="field"><label>Document PDF</label><input id="docFile" type="file" accept="application/pdf"></div><button class="btn blue" id="createDoc">Créer le dossier</button></section><section class="card"><div class="row between"><div><h2>Documents</h2><p class="muted">Suivi des signatures et téléchargement du PDF courant.</p></div></div><div class="doc-list">${docs}</div></section></main>`, `<span class="small">${esc(state.session.user.email)}</span><button class="btn secondary" id="logout">Déconnexion</button>`)
  document.querySelector('#logout').onclick = () => supabase.auth.signOut()
  document.querySelector('#createDoc').onclick = createDocument
  document.querySelectorAll('.doc-item').forEach(el => el.onclick = () => openDocument(el.dataset.id))
}

async function createDocument() {
  const name = document.querySelector('#docName').value.trim()
  const file = document.querySelector('#docFile').files[0]
  if (!name || !file) return flash('error', 'Nom et PDF obligatoires.')
  const docId = uid()
  const owner = state.session.user.id
  const storagePath = `${owner}/${docId}/original.pdf`
  const { error: insertError } = await supabase.from('signatureflow_documents').insert({ id: docId, owner_id: owner, name, storage_path: storagePath, current_storage_path: storagePath })
  if (insertError) return flash('error', insertError.message)
  const { error: uploadError } = await supabase.storage.from('signatureflow-documents').upload(storagePath, file, { contentType: 'application/pdf', upsert: false })
  if (uploadError) {
    await supabase.from('signatureflow_documents').delete().eq('id', docId)
    return flash('error', uploadError.message)
  }
  await loadDocuments()
  await openDocument(docId)
}

async function openDocument(id) {
  const { data: doc, error } = await supabase.from('signatureflow_documents').select('*').eq('id', id).single()
  if (error) return flash('error', error.message)
  const [{ data: signers }, { data: fields }, { data: audit }] = await Promise.all([
    supabase.from('signatureflow_signers').select('*').eq('document_id', id).order('signing_order'),
    supabase.from('signatureflow_signature_fields').select('*').eq('document_id', id).order('page'),
    supabase.from('signatureflow_audit_events').select('*').eq('document_id', id).order('created_at', { ascending: false }).limit(25)
  ])
  state.currentDoc = doc
  state.signers = signers || []
  state.fields = fields || []
  state.audit = audit || []
  state.page = 1
  state.placementSignerId = null
  await loadPdfForAdmin()
  renderEditor()
}

async function loadPdfForAdmin() {
  const path = state.currentDoc.current_storage_path || state.currentDoc.storage_path
  const { data, error } = await supabase.storage.from('signatureflow-documents').download(path)
  if (error) throw error
  state.pdfBytes = await data.arrayBuffer()
  state.pdf = await pdfjsLib.getDocument({ data: state.pdfBytes.slice(0) }).promise
}

function renderEditor() {
  const signerOptions = state.signers.map(s => `<option value="${s.id}">${esc(s.name)} — ${esc(s.email)}</option>`).join('')
  const signers = state.signers.map(s => `<div class="signer-card stack"><div class="row between"><div><strong>${esc(s.name)}</strong><div class="small muted">${esc(s.email)}</div></div><span class="pill ${s.status==='signed'?'signed':'pending'}">${esc(s.status)}</span></div><div class="small">Ordre : ${s.signing_order}${s.signed_at ? ` · signé ${new Date(s.signed_at).toLocaleString('fr-FR')}` : ''}</div>${s.status!=='signed' ? `<button class="btn secondary small remove-signer" data-id="${s.id}">Retirer</button>` : ''}</div>`).join('') || '<p class="muted">Ajoute au moins un signataire.</p>'
  const audit = state.audit.map(a => `<div class="signer-card"><strong>${esc(a.event_type)}</strong><div class="small muted">${new Date(a.created_at).toLocaleString('fr-FR')}</div></div>`).join('') || '<p class="muted">Aucun événement.</p>'
  app.innerHTML = layout(`<main class="container grid grid-3"><aside class="card stack"><div><h3>${esc(state.currentDoc.name)}</h3><div class="small muted">Statut : ${esc(state.currentDoc.status)}</div></div>${messageHtml()}<hr><div><h3>Signataires</h3></div><div class="field"><label>Nom</label><input id="signerName"></div><div class="field"><label>E-mail</label><input id="signerEmail" type="email"></div><button class="btn" id="addSigner">Ajouter</button><div class="stack">${signers}</div><button class="btn blue" id="sendInvites" ${state.signers.length?'':'disabled'}>Envoyer les liens de signature</button><button class="btn secondary" id="back">← Documents</button></aside><section class="card"><div class="toolbar"><button class="btn secondary" id="prevPage">←</button><strong>Page <span id="pageNum">${state.page}</span> / ${state.pdf.numPages}</strong><button class="btn secondary" id="nextPage">→</button><button class="btn blue" id="autoDetect" ${state.signers.length?'':'disabled'}>Analyser les signatures</button><select id="placeSigner" style="max-width:260px"><option value="">Placement manuel…</option>${signerOptions}</select><button class="btn secondary" id="saveFields">Enregistrer les zones</button></div><div class="notice small">Analyse automatique : recherche les libellés “signature”, “signataire”, “visa”, “signé”. Pour un PDF scanné ou une mise en page ambiguë, utilise le placement manuel.</div><div id="pdfHost" style="margin-top:14px"></div></section><aside class="card stack"><h3>Zones de signature</h3><div id="fieldList"></div><div class="warning small">Les liens sont individuels. Un signataire reçoit uniquement l’accès temporaire nécessaire à son document.</div><button class="btn secondary" id="refreshDoc">Actualiser les statuts</button><button class="btn secondary" id="downloadCurrent">Télécharger le PDF courant</button><hr><h3>Historique</h3><div class="stack">${audit}</div></aside></main>`, `<button class="btn secondary" id="logout">Déconnexion</button>`)
  document.querySelector('#logout').onclick = () => supabase.auth.signOut()
  document.querySelector('#back').onclick = () => loadDocuments()
  document.querySelector('#addSigner').onclick = addSigner
  document.querySelector('#sendInvites').onclick = sendInvites
  document.querySelector('#prevPage').onclick = async () => { if (state.page > 1) { state.page--; await drawEditorPage() } }
  document.querySelector('#nextPage').onclick = async () => { if (state.page < state.pdf.numPages) { state.page++; await drawEditorPage() } }
  document.querySelector('#autoDetect').onclick = autoDetectFields
  document.querySelector('#placeSigner').onchange = e => { state.placementSignerId = e.target.value || null; drawEditorPage() }
  document.querySelector('#saveFields').onclick = saveFields
  document.querySelector('#refreshDoc').onclick = () => openDocument(state.currentDoc.id)
  document.querySelector('#downloadCurrent').onclick = downloadCurrent
  document.querySelectorAll('.remove-signer').forEach(el => el.onclick = () => removeSigner(el.dataset.id))
  drawEditorPage()
  drawFieldList()
}

async function removeSigner(id) {
  const signer = state.signers.find(s => s.id === id)
  if (!signer || signer.status === 'signed') return
  const { error } = await supabase.from('signatureflow_signers').delete().eq('id', id)
  if (error) return flash('error', error.message)
  state.signers = state.signers.filter(s => s.id !== id)
  state.fields = state.fields.filter(f => f.signer_id !== id)
  renderEditor()
}

async function addSigner() {
  const name = document.querySelector('#signerName').value.trim()
  const email = document.querySelector('#signerEmail').value.trim().toLowerCase()
  if (!name || !email) return flash('error', 'Nom et e-mail obligatoires.')
  const signing_order = (state.signers.at(-1)?.signing_order || 0) + 1
  const { data, error } = await supabase.from('signatureflow_signers').insert({ document_id: state.currentDoc.id, name, email, signing_order }).select().single()
  if (error) return flash('error', error.message)
  state.signers.push(data)
  renderEditor()
}

async function drawEditorPage() {
  const page = await state.pdf.getPage(state.page)
  const viewport = page.getViewport({ scale: state.scale })
  const host = document.querySelector('#pdfHost')
  if (!host) return
  host.innerHTML = `<div class="pdf-wrap"><div class="pdf-stage" id="stage"><canvas id="pdfCanvas"></canvas></div></div>`
  const canvas = document.querySelector('#pdfCanvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  const stage = document.querySelector('#stage')
  stage.style.width = `${viewport.width}px`; stage.style.height = `${viewport.height}px`
  state.fields.filter(f => Number(f.page) === state.page).forEach(f => renderFieldOverlay(stage, f, viewport))
  stage.onclick = e => {
    if (!state.placementSignerId || e.target.classList.contains('sig-field')) return
    const r = stage.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    state.fields.push({ id: uid(), document_id: state.currentDoc.id, signer_id: state.placementSignerId, page: state.page, x: Math.min(x, .72), y: Math.min(y, .88), width: .25, height: .09, _new: true })
    drawEditorPage(); drawFieldList()
  }
  document.querySelector('#pageNum').textContent = state.page
}

function renderFieldOverlay(stage, f, viewport) {
  const el = document.createElement('div')
  const signer = state.signers.find(s => s.id === f.signer_id)
  el.className = `sig-field ${signer?.status==='signed'?'signed':''}`
  el.style.left = `${f.x * viewport.width}px`
  el.style.top = `${f.y * viewport.height}px`
  el.style.width = `${f.width * viewport.width}px`
  el.style.height = `${f.height * viewport.height}px`
  el.textContent = signer ? signer.name : 'Signature'
  el.title = 'Cliquer pour supprimer cette zone'
  el.onclick = ev => { ev.stopPropagation(); state.fields = state.fields.filter(x => x.id !== f.id); drawEditorPage(); drawFieldList() }
  stage.appendChild(el)
}

function drawFieldList() {
  const el = document.querySelector('#fieldList'); if (!el) return
  el.innerHTML = state.fields.map(f => { const s = state.signers.find(x => x.id===f.signer_id); return `<div class="signer-card"><strong>${esc(s?.name || 'Inconnu')}</strong><div class="small muted">Page ${f.page} · x ${Number(f.x).toFixed(2)} · y ${Number(f.y).toFixed(2)}</div></div>` }).join('') || '<p class="muted">Aucune zone.</p>'
}

async function autoDetectFields() {
  if (!state.signers.length) return
  const found = []
  let signerIndex = 0
  for (let p = 1; p <= state.pdf.numPages; p++) {
    const page = await state.pdf.getPage(p)
    const viewport = page.getViewport({ scale: 1 })
    const text = await page.getTextContent()
    for (const item of text.items) {
      const value = String(item.str || '').toLowerCase()
      if (!/(signature|signataire|visa|signé|signe ici)/i.test(value)) continue
      const transformed = pdfjsLib.Util.transform(viewport.transform, item.transform)
      const tx = transformed[4]
      const ty = transformed[5]
      const x = Math.max(0.02, Math.min(0.72, tx / viewport.width))
      const yTop = Math.max(0.02, Math.min(0.86, ty / viewport.height))
      const signer = state.signers[signerIndex % state.signers.length]
      found.push({ id: uid(), document_id: state.currentDoc.id, signer_id: signer.id, page: p, x, y: Math.min(.88, yTop + .02), width: .25, height: .09, _new: true })
      signerIndex++
    }
  }
  if (!found.length) return flash('warning', 'Aucun libellé de signature détecté. Utilise le placement manuel.')
  state.fields = found
  state.page = found[0].page
  await drawEditorPage(); drawFieldList(); flash('success', `${found.length} zone(s) détectée(s). Vérifie leur position avant enregistrement.`)
}

async function saveFields() {
  if (!state.fields.length) { flash('error', 'Aucune zone de signature.'); return false }
  const { error: delErr } = await supabase.from('signatureflow_signature_fields').delete().eq('document_id', state.currentDoc.id)
  if (delErr) { flash('error', delErr.message); return false }
  const rows = state.fields.map(({id,document_id,signer_id,page,x,y,width,height}) => ({id,document_id,signer_id,page,x,y,width,height}))
  const { error } = await supabase.from('signatureflow_signature_fields').insert(rows)
  if (error) { flash('error', error.message); return false }
  state.fields = rows
  flash('success', 'Zones de signature enregistrées.')
  return true
}

async function sendInvites() {
  const saved = await saveFields()
  if (!saved) return
  const { data, error } = await supabase.functions.invoke('signatureflow-invite-signer', { body: { documentId: state.currentDoc.id, appUrl: APP_URL } })
  if (error) return flash('error', error.message)
  flash('success', `${data.sent || 0} invitation(s) envoyée(s).`)
}

async function downloadCurrent() {
  const path = state.currentDoc.current_storage_path || state.currentDoc.storage_path
  const { data, error } = await supabase.storage.from('signatureflow-documents').download(path)
  if (error) return flash('error', error.message)
  const url = URL.createObjectURL(data)
  const a = document.createElement('a'); a.href = url; a.download = `${state.currentDoc.name.replace(/[^a-z0-9-_]+/gi,'_')}.pdf`; a.click(); URL.revokeObjectURL(url)
}

async function renderSigningPage(token) {
  if (!configured) return renderSetupMissing()
  app.innerHTML = layout(`<main class="sign-page"><div class="card">Chargement du document…</div></main>`)
  const { data, error } = await supabase.functions.invoke('signatureflow-get-signing-context', { body: { token } })
  if (error || !data) {
    app.innerHTML = layout(`<main class="sign-page"><div class="card error">Lien invalide, expiré ou non disponible.</div></main>`)
    return
  }
  if (data.blocked) {
    app.innerHTML = layout(`<main class="sign-page"><div class="card warning"><h2>Signature en attente</h2><p>Un signataire précédent doit encore signer ce document. Tu peux conserver ce lien et réessayer plus tard.</p></div></main>`)
    return
  }
  if (!data.document) {
    app.innerHTML = layout(`<main class="sign-page"><div class="card error">Document indisponible.</div></main>`)
    return
  }
  if (data.signer.status === 'signed') {
    app.innerHTML = layout(`<main class="sign-page"><div class="card success"><h2>Document déjà signé</h2><p>La signature de ${esc(data.signer.name)} a déjà été enregistrée.</p></div></main>`)
    return
  }

  const response = await fetch(data.document.signedUrl)
  const pdfBytes = await response.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise

  app.innerHTML = layout(`<main class="sign-page stack"><section class="card"><h2>${esc(data.document.name)}</h2><p>Signataire : <strong>${esc(data.signer.name)}</strong> — ${esc(data.signer.email)}</p><div class="notice">Vérifie le document et les emplacements indiqués avant de signer.</div></section><section class="card"><div id="signPdf" class="stack"></div></section><section class="card stack"><h3>Signature</h3><div class="field"><label>Nom et prénom</label><input id="typedName" value="${esc(data.signer.name)}"></div><div class="signature-box"><canvas id="signatureCanvas"></canvas></div><div class="row"><button class="btn secondary" id="clearSig">Effacer</button></div><label class="row" style="align-items:flex-start"><input id="consent" type="checkbox" style="width:auto;margin-top:3px"><span>Je confirme avoir pris connaissance du document et j’accepte d’y apposer cette signature électronique.</span></label><button class="btn blue" id="submitSig">Signer le document</button><div id="signMsg"></div></section></main>`)

  const host = document.querySelector('#signPdf')
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const viewport = page.getViewport({ scale: 1.15 })
    const pageTitle = document.createElement('div'); pageTitle.className = 'small muted'; pageTitle.textContent = `Page ${p} / ${pdf.numPages}`; host.appendChild(pageTitle)
    const wrap = document.createElement('div'); wrap.className = 'pdf-wrap'
    const stage = document.createElement('div'); stage.className = 'pdf-stage'; stage.style.width = `${viewport.width}px`; stage.style.height = `${viewport.height}px`
    const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
    stage.appendChild(canvas); wrap.appendChild(stage); host.appendChild(wrap)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    data.fields.filter(f => Number(f.page) === p).forEach(f => {
      const o = document.createElement('div'); o.className = 'signature-overlay'; o.textContent = 'Votre signature'
      o.style.left = `${f.x*viewport.width}px`; o.style.top = `${f.y*viewport.height}px`; o.style.width=`${f.width*viewport.width}px`; o.style.height=`${f.height*viewport.height}px`; stage.appendChild(o)
    })
  }

  const sigCanvas = document.querySelector('#signatureCanvas')
  const ratio = Math.max(window.devicePixelRatio || 1, 1)
  sigCanvas.width = sigCanvas.offsetWidth * ratio; sigCanvas.height = 220 * ratio; sigCanvas.getContext('2d').scale(ratio, ratio)
  const pad = new SignaturePad(sigCanvas, { minWidth: 0.7, maxWidth: 2.2 })
  document.querySelector('#clearSig').onclick = () => pad.clear()
  document.querySelector('#submitSig').onclick = async () => {
    const msg = document.querySelector('#signMsg')
    if (pad.isEmpty()) { msg.innerHTML = '<div class="error">La signature est vide.</div>'; return }
    if (!document.querySelector('#consent').checked) { msg.innerHTML = '<div class="error">Le consentement est obligatoire.</div>'; return }
    const typedName = document.querySelector('#typedName').value.trim()
    if (!typedName) { msg.innerHTML = '<div class="error">Nom et prénom obligatoires.</div>'; return }
    const button = document.querySelector('#submitSig'); button.disabled = true; button.textContent = 'Enregistrement…'
    const payload = { token, typedName, accepted: true, signatureDataUrl: pad.toDataURL('image/png') }
    const { data: result, error: submitError } = await supabase.functions.invoke('signatureflow-submit-signature', { body: payload })
    if (submitError || !result?.ok) { button.disabled = false; button.textContent = 'Signer le document'; msg.innerHTML = `<div class="error">${esc(submitError?.message || result?.error || 'Erreur')}</div>`; return }
    sessionStorage.removeItem('signatureflow_sign_token')
    app.innerHTML = layout(`<main class="sign-page"><div class="card success"><h2>Signature enregistrée</h2><p>Merci. Le document a été signé et la piste d’audit a été mise à jour.</p><p class="small">Empreinte du PDF signé : <span class="kbd">${esc(result.sha256 || '')}</span></p></div></main>`)
  }
}

boot().catch(err => { console.error(err); app.innerHTML = `<main class="container"><div class="error">${esc(err.message)}</div></main>` })
