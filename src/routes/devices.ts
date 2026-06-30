import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import qrcode from 'qrcode'
import { supabase, supabaseAuth } from '../lib/supabase.js'
import {
  getSocket,
  getAllSessions,
  getSessionInfo,
  startSession,
  removeSession,
  stopSession,
  sessionEvents,
} from '../lib/session-manager.js'

type Variables = {
  userId: string
  userEmail: string
}

export const devicesRouter = new Hono<{ Variables: Variables }>()

/** GET /api/devices — list all devices from Supabase + live status */
devicesRouter.get('/', async (c) => {
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)

  // Merge live in-memory status
  const liveSessions = getAllSessions()
  const merged = (data || []).map((device) => {
    const live = liveSessions.find((s) => s.id === device.id)
    return {
      ...device,
      status: live?.status ?? device.status,
      number: live?.number ?? device.number,
    }
  })

  return c.json(merged)
})

/** POST /api/devices — create a new device and start a session */
devicesRouter.post('/', async (c) => {
  const body = await c.req.json<{ id: string; name: string }>()

  if (!body.id || !body.name) {
    return c.json({ error: 'id and name are required' }, 400)
  }

  // Validate id slug (alphanumeric + hyphens only)
  if (!/^[a-z0-9-]+$/.test(body.id)) {
    return c.json({ error: 'id must be lowercase alphanumeric with hyphens' }, 400)
  }

  // Check for duplicate
  const { data: existing } = await supabase
    .from('devices')
    .select('id')
    .eq('id', body.id)
    .single()

  if (existing) {
    return c.json({ error: 'Device ID already exists' }, 409)
  }

  // Insert into Supabase
  const { error } = await supabase.from('devices').insert({
    id: body.id,
    name: body.name,
    status: 'pending',
  })

  if (error) return c.json({ error: error.message }, 500)

  // Start Baileys session
  startSession(body.id).catch(console.error)

  return c.json({ ok: true, id: body.id }, 201)
})

/** DELETE /api/devices/:id — remove device completely */
devicesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await removeSession(id)
  return c.json({ ok: true })
})

/** POST /api/devices/:id/disconnect — stop session, keep auth files */
devicesRouter.post('/:id/disconnect', async (c) => {
  const id = c.req.param('id')
  await stopSession(id)
  return c.json({ ok: true })
})

/** POST /api/devices/:id/reconnect — restart session from saved auth */
devicesRouter.post('/:id/reconnect', async (c) => {
  const id = c.req.param('id')

  // Verify device exists in DB
  const { data } = await supabase
    .from('devices')
    .select('id')
    .eq('id', id)
    .single()

  if (!data) return c.json({ error: 'Device not found' }, 404)

  startSession(id).catch(console.error)
  return c.json({ ok: true })
})

/** GET /api/devices/:id/qr — SSE stream for QR codes (auth via ?token= query param) */
devicesRouter.get('/:id/qr', async (c) => {
  const deviceId = c.req.param('id')

  // SSE: EventSource doesn't support custom headers, so accept token via query param
  const qToken = c.req.query('token') ?? c.req.header('Authorization')?.slice(7)
  if (qToken) {
    const { data, error } = await supabaseAuth.auth.getUser(qToken)
    if (error || !data.user) {
      console.error('[QR AUTH ERROR] Supabase getUser error:', error)
      return c.json({ error: 'Unauthorized' }, 401)
    }
  } else {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  return streamSSE(c, async (stream) => {
    // Send cached QR immediately if available
    const info = getSessionInfo(deviceId)
    if (info?.qr) {
      const dataUri = await qrcode.toDataURL(info.qr)
      await stream.writeSSE({
        data: JSON.stringify({ qr: dataUri }),
        event: 'qr',
        id: '0',
      })
    }

    let msgId = 1

    const onQr = async (rawQr: string) => {
      try {
        const dataUri = await qrcode.toDataURL(rawQr)
        await stream.writeSSE({
          data: JSON.stringify({ qr: dataUri }),
          event: 'qr',
          id: String(msgId++),
        })
      } catch {
        // stream may be closed
      }
    }

    const onStatus = async (status: string) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify({ status }),
          event: 'status',
          id: String(msgId++),
        })
        if (status === 'connected') {
          await stream.close()
        }
      } catch {
        // ignore
      }
    }

    sessionEvents.on(`qr:${deviceId}`, onQr)
    sessionEvents.on(`status:${deviceId}`, onStatus)

    // Keep-alive ping every 15 seconds
    let alive = true
    stream.onAbort(() => {
      alive = false
      sessionEvents.off(`qr:${deviceId}`, onQr)
      sessionEvents.off(`status:${deviceId}`, onStatus)
    })

    while (alive && !stream.aborted) {
      await stream.sleep(15_000)
      if (!stream.aborted && alive) {
        await stream.writeSSE({ data: 'ping', event: 'ping', id: String(msgId++) })
      }
    }

    sessionEvents.off(`qr:${deviceId}`, onQr)
    sessionEvents.off(`status:${deviceId}`, onStatus)
  })
})
