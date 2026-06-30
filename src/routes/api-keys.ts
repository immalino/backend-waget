import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { authMiddleware } from '../lib/auth-middleware.js'
import { randomBytes } from 'crypto'

type Variables = {
  userId: string
  userEmail: string
}

export const apiKeysRouter = new Hono<{ Variables: Variables }>()

// Protect all routes in this router
apiKeysRouter.use('*', authMiddleware)

// Restrict access so that a call authenticated by an API Key itself cannot manage API keys.
apiKeysRouter.use('*', async (c, next) => {
  if (c.get('userId') === 'api-key-system') {
    return c.json({ error: 'Forbidden — API Keys cannot manage other API Keys' }, 403)
  }
  await next()
})

/** GET /api/api-keys — List all API keys */
apiKeysRouter.get('/', async (c) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})

/** POST /api/api-keys — Create a new API key */
apiKeysRouter.post('/', async (c) => {
  const body = await c.req.json<{ name: string }>()
  if (!body.name) {
    return c.json({ error: 'Name is required' }, 400)
  }

  // Generate a cryptographically secure random API key starting with wag_sk_
  const randomStr = randomBytes(24).toString('hex')
  const newKey = `wag_sk_${randomStr}`

  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      name: body.name.trim(),
      key: newKey,
      enabled: true,
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

/** PUT /api/api-keys/:id — Enable/disable or rename an API key */
apiKeysRouter.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ enabled?: boolean; name?: string }>()

  const patch: Record<string, any> = {}
  if (body.enabled !== undefined) patch.enabled = body.enabled
  if (body.name !== undefined) patch.name = body.name.trim()

  const { data, error } = await supabase
    .from('api_keys')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

/** DELETE /api/api-keys/:id — Revoke/delete an API key */
apiKeysRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')

  const { error } = await supabase
    .from('api_keys')
    .delete()
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})
