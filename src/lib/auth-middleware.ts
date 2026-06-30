import type { Context, Next } from 'hono'
import { supabaseAuth } from './supabase.js'

/**
 * Hono middleware — validates the Bearer JWT from Supabase Auth.
 * Sets `userId` and `userEmail` in context variables if valid.
 * Returns 401 otherwise.
 */
export async function authMiddleware(c: Context<{ Variables: { userId: string; userEmail: string } }>, next: Next) {
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
