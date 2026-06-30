import type { Context, Next } from 'hono'
import { supabaseAuth, supabase } from './supabase.js'

/**
 * Hono middleware — validates EITHER:
 * 1. Static API Key from X-API-Key header (for external server integration)
 * 2. Bearer JWT from Supabase Auth (for frontend dashboard)
 * 
 * Sets `userId` and `userEmail` in context variables if valid.
 * Returns 401 otherwise.
 */
export async function authMiddleware(c: Context<{ Variables: { userId: string; userEmail: string } }>, next: Next) {
  const apiKey = c.req.header('X-API-Key')

  // 1. API Key Auth Flow
  if (apiKey) {
    const { data, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('key', apiKey)
      .eq('enabled', true)
      .single()

    if (error || !data) {
      return c.json({ error: 'Unauthorized — invalid or disabled API Key' }, 401)
    }

    // Update last_used_at in background (fire-and-forget)
    supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(() => {}, () => null)

    c.set('userId', 'api-key-system')
    c.set('userEmail', 'api-key@system.local')
    return next()
  }

  // 2. JWT Auth Flow (Bearer Token)
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized — missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.slice(7)

  const { data, error } = await supabaseAuth.auth.getUser(token)

  if (error || !data.user) {
    console.error('[AUTH MIDDLEWARE ERROR] Supabase getUser error:', error)
    return c.json({ error: 'Unauthorized — invalid or expired token' }, 401)
  }

  c.set('userId', data.user.id)
  c.set('userEmail', data.user.email ?? '')

  await next()
}
