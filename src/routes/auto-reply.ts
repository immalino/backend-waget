import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { invalidateRulesCache } from '../lib/auto-reply.js'

type Variables = {
  userId: string
  userEmail: string
}

export const autoReplyRouter = new Hono<{ Variables: Variables }>()

/** GET /api/auto-reply — list all rules */
autoReplyRouter.get('/', async (c) => {
  const { data, error } = await supabase
    .from('auto_reply_rules')
    .select('*')
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})

/** POST /api/auto-reply — create a rule */
autoReplyRouter.post('/', async (c) => {
  const body = await c.req.json<{
    keyword: string
    response: string
    sender_id?: string
    enabled?: boolean
  }>()

  if (!body.keyword || !body.response) {
    return c.json({ error: 'keyword and response are required' }, 400)
  }

  const { data, error } = await supabase
    .from('auto_reply_rules')
    .insert({
      keyword: body.keyword.toLowerCase().trim(),
      response: body.response,
      sender_id: body.sender_id ?? 'All',
      enabled: body.enabled ?? true,
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  invalidateRulesCache()
  return c.json(data, 201)
})

/** PUT /api/auto-reply/:id — update a rule */
autoReplyRouter.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json<Partial<{
    keyword: string
    response: string
    sender_id: string
    enabled: boolean
  }>>()

  const patch: Record<string, unknown> = {}
  if (body.keyword  !== undefined) patch.keyword   = body.keyword.toLowerCase().trim()
  if (body.response !== undefined) patch.response  = body.response
  if (body.sender_id !== undefined) patch.sender_id = body.sender_id
  if (body.enabled  !== undefined) patch.enabled   = body.enabled

  const { data, error } = await supabase
    .from('auto_reply_rules')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  invalidateRulesCache()
  return c.json(data)
})

/** DELETE /api/auto-reply/:id — delete a rule */
autoReplyRouter.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))

  const { error } = await supabase
    .from('auto_reply_rules')
    .delete()
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)

  invalidateRulesCache()
  return c.json({ ok: true })
})
