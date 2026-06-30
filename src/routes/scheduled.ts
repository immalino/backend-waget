import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { authMiddleware } from '../lib/auth-middleware.js'

type Variables = {
  userId: string
  userEmail: string
}

export const scheduledRouter = new Hono<{ Variables: Variables }>()

// Protect all routes in this router
scheduledRouter.use('*', authMiddleware)

/** GET /api/scheduled — List scheduled messages (with optional status filter) */
scheduledRouter.get('/', async (c) => {
  const status = c.req.query('status') // optional filter: pending, sent, failed

  let query = supabase
    .from('scheduled_messages')
    .select('*')
    .order('scheduled_at', { ascending: true })

  if (status) {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})

/** POST /api/scheduled — Schedule a new message */
scheduledRouter.post('/', async (c) => {
  const body = await c.req.json<{
    deviceId: string
    to: string
    message: string
    mediaUrl?: string
    mediaType?: string
    scheduledAt: string // ISO string
    repeat?: 'daily' | 'weekly' | 'monthly' | null
  }>()

  if (!body.deviceId || !body.to || !body.message || !body.scheduledAt) {
    return c.json({ error: 'deviceId, to, message, and scheduledAt are required' }, 400)
  }

  // Validate scheduled time is in the future
  const scheduledTime = new Date(body.scheduledAt)
  if (isNaN(scheduledTime.getTime())) {
    return c.json({ error: 'invalid scheduledAt format' }, 400)
  }
  if (scheduledTime.getTime() <= Date.now()) {
    return c.json({ error: 'scheduledAt must be a date in the future' }, 400)
  }

  const { data, error } = await supabase
    .from('scheduled_messages')
    .insert({
      device_id: body.deviceId,
      to: body.to,
      message: body.message,
      media_url: body.mediaUrl || null,
      media_type: body.mediaType || null,
      scheduled_at: scheduledTime.toISOString(),
      repeat: body.repeat || null,
      status: 'pending'
    })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data, 201)
})

/** PUT /api/scheduled/:id — Edit a pending scheduled message */
scheduledRouter.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    deviceId?: string
    to?: string
    message?: string
    mediaUrl?: string
    mediaType?: string
    scheduledAt?: string
    repeat?: 'daily' | 'weekly' | 'monthly' | null
    status?: 'pending' | 'sent' | 'failed'
  }>()

  // First, verify the message exists and is still pending
  const { data: existing, error: fetchError } = await supabase
    .from('scheduled_messages')
    .select('status')
    .eq('id', id)
    .single()

  if (fetchError || !existing) {
    return c.json({ error: 'Scheduled message not found' }, 404)
  }

  const patch: Record<string, any> = {}
  if (body.deviceId !== undefined) patch.device_id = body.deviceId
  if (body.to !== undefined) patch.to = body.to
  if (body.message !== undefined) patch.message = body.message
  if (body.mediaUrl !== undefined) patch.media_url = body.mediaUrl
  if (body.mediaType !== undefined) patch.media_type = body.mediaType
  if (body.repeat !== undefined) patch.repeat = body.repeat
  if (body.status !== undefined) patch.status = body.status

  if (body.scheduledAt !== undefined) {
    const scheduledTime = new Date(body.scheduledAt)
    if (isNaN(scheduledTime.getTime())) {
      return c.json({ error: 'invalid scheduledAt format' }, 400)
    }
    patch.scheduled_at = scheduledTime.toISOString()
  }

  const { data, error } = await supabase
    .from('scheduled_messages')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

/** DELETE /api/scheduled/:id — Cancel and delete a scheduled message */
scheduledRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')

  const { error } = await supabase
    .from('scheduled_messages')
    .delete()
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ ok: true })
})
