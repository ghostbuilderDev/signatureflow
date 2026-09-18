import { createClient } from 'npm:@supabase/supabase-js@2'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

export function adminClient() {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY')
  if (!key) throw new Error('Missing server-side Supabase secret key')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function requireUser(req: Request) {
  const auth = req.headers.get('Authorization') || ''
  const jwt = auth.replace(/^Bearer\s+/i, '')
  if (!jwt) throw new Error('UNAUTHORIZED')
  const url = Deno.env.get('SUPABASE_URL')!
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!
  const client = createClient(url, publicKey, { auth: { persistSession: false } })
  const { data, error } = await client.auth.getUser(jwt)
  if (error || !data.user) throw new Error('UNAUTHORIZED')
  return data.user
}

export function randomToken(bytes = 32) {
  const array = new Uint8Array(bytes)
  crypto.getRandomValues(array)
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Text(value: string) {
  const bytes = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Bytes(value: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
