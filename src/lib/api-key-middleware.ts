import type { Context, Next } from 'hono'
import { supabase } from './supabase.js'

/**
 * Hono middleware — validates the static API Key in the X-API-Key header.
 * Updates the last_used_at timestamp on successful match.
 * Returns 401 otherwise.
 */
export async function apiKeyMiddleware(c: Context, next: Next) {
  const apiKey = c.req.header('X-API-Key')

  if (!apiKey) {
    return c.json({ error: 'Unauthorized — missing X-API-Key header' }, 401)
  }

  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key', apiKey)
    .eq('enabled', true)
    .single()

  if (error || !data) {
    return c.json({ error: 'Unauthorized — invalid or disabled API Key' }, 401)
  }

  // Update last_used_at timestamp in background (fire-and-forget)
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {}, () => null)

  await next()
}
