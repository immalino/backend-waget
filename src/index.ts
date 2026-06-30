import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import qrcode from 'qrcode'

import {
  startSession,
  stopSession,
  removeSession,
  getSocket,
  getAllSessions,
  getSessionInfo,
  restoreSessions,
  sessionEvents,
} from './lib/session-manager.js'
import { supabase, supabaseAuth } from './lib/supabase.js'
import { authMiddleware } from './lib/auth-middleware.js'
import { invalidateRulesCache } from './lib/auto-reply.js'
import {
  startBlast,
  getBlastStatus,
  stopBlast,
  getAllBlasts,
} from './lib/blast-queue.js'

// ── App ───────────────────────────────────────────────────────────────────────

type Variables = {
  userId: string
  userEmail: string
}

const app = new Hono<{ Variables: Variables }>()

const corsOrigin = (process.env.CORS_ORIGIN || 'http://localhost:5173').replace(/\/$/, '')

// ── CORS Debug Logger Middleware ─────────────────────────────────────────────
app.use('*', async (c, next) => {
  const method = c.req.method
  const url = c.req.url
  const reqHeaders = {
    origin: c.req.header('origin'),
    host: c.req.header('host'),
    'access-control-request-method': c.req.header('access-control-request-method'),
    'access-control-request-headers': c.req.header('access-control-request-headers'),
  }

  console.log(`\n[CORS DEBUG - REQUEST] ${method} ${url}`)
  console.log(`  Origin: ${reqHeaders.origin || 'none'}`)
  console.log(`  Headers:`, JSON.stringify(reqHeaders, null, 2))

  await next()

  const status = c.res?.status ?? 'unknown'
  const resHeaders = c.res ? {
    'access-control-allow-origin': c.res.headers.get('access-control-allow-origin'),
    'access-control-allow-methods': c.res.headers.get('access-control-allow-methods'),
    'access-control-allow-headers': c.res.headers.get('access-control-allow-headers'),
    'access-control-allow-credentials': c.res.headers.get('access-control-allow-credentials'),
  } : null

  console.log(`[CORS DEBUG - RESPONSE] ${method} ${url} - Status: ${status}`)
  console.log(`  Allowed Origin: ${resHeaders?.['access-control-allow-origin'] || 'none'}`)
  if (resHeaders) {
    console.log(`  CORS Headers:`, JSON.stringify(resHeaders, null, 2))
  }
  console.log('──────────────────────────────────────────────────')
})

// Allow both localhost dev and any Vercel preview URLs
app.use(
  '/api/*',
  cors({
    origin: (origin) => {
      if (!origin) return corsOrigin
      if (
        origin === corsOrigin ||
        origin.endsWith('.vercel.app')
      ) {
        return origin
      }
      return corsOrigin
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
)

// ── Health (public) ───────────────────────────────────────────────────────────

app.get('/api/health', (c) => {
  const sessions = getAllSessions()
  const connected = sessions.filter((s) => s.status === 'connected').length
  return c.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    sessions: sessions.length,
    connected,
  })
})

// ── Auth (public) ─────────────────────────────────────────────────────────────

/** POST /api/auth/login — sign in with email + password via Supabase Auth */
app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>()

  if (!body.email || !body.password) {
    return c.json({ error: 'email and password are required' }, 400)
  }

  const { data, error } = await supabaseAuth.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  })

  if (error || !data.session) {
    return c.json({ error: error?.message ?? 'Login failed' }, 401)
  }

  return c.json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: data.user.id,
      email: data.user.email,
      name: data.user.user_metadata?.name ?? data.user.email?.split('@')[0],
    },
  })
})

/** POST /api/auth/logout — revoke the current session */
app.post('/api/auth/logout', authMiddleware, async (c) => {
  const authHeader = c.req.header('Authorization')!
  const token = authHeader.slice(7)

  // Sign out from Supabase (invalidates the refresh token server-side)
  await supabaseAuth.auth.admin.signOut(token).catch(() => null)

  return c.json({ ok: true })
})

/** GET /api/auth/me — return current user info from JWT */
app.get('/api/auth/me', authMiddleware, (c) => {
  return c.json({
    id: c.get('userId'),
    email: c.get('userEmail'),
  })
})

/** PUT /api/auth/profile — update current user name and email */
app.put('/api/auth/profile', authMiddleware, async (c) => {
  const body = await c.req.json<{ name: string; email?: string }>()
  const userId = c.get('userId')

  const updateData: any = {
    user_metadata: { name: body.name }
  }
  if (body.email) {
    updateData.email = body.email
  }

  const { data, error } = await supabase.auth.admin.updateUserById(userId, updateData)
  if (error || !data.user) {
    return c.json({ error: error?.message ?? 'Failed to update profile' }, 400)
  }

  return c.json({
    ok: true,
    user: {
      id: data.user.id,
      email: data.user.email,
      name: data.user.user_metadata?.name ?? data.user.email?.split('@')[0],
    }
  })
})

/** PUT /api/auth/password — update current user password */
app.put('/api/auth/password', authMiddleware, async (c) => {
  const body = await c.req.json<{ password: string }>()
  const userId = c.get('userId')

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    password: body.password
  })
  if (error) {
    return c.json({ error: error.message }, 400)
  }

  return c.json({ ok: true })
})

// ── Auth guard for all other /api/* routes ────────────────────────────────────
app.use('/api/*', async (c, next) => {
  // Skip routes already handled above (health + auth endpoints)
  const path = c.req.path
  if (
    path === '/api/health' ||
    path.startsWith('/api/auth/')
  ) {
    return next()
  }
  return authMiddleware(c, next)
})

// ── Devices ───────────────────────────────────────────────────────────────────

/** GET /api/devices — list all devices from Supabase + live status */
app.get('/api/devices', async (c) => {
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
app.post('/api/devices', async (c) => {
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
app.delete('/api/devices/:id', async (c) => {
  const id = c.req.param('id')
  await removeSession(id)
  return c.json({ ok: true })
})

/** POST /api/devices/:id/disconnect — stop session, keep auth files */
app.post('/api/devices/:id/disconnect', async (c) => {
  const id = c.req.param('id')
  await stopSession(id)
  return c.json({ ok: true })
})

/** POST /api/devices/:id/reconnect — restart session from saved auth */
app.post('/api/devices/:id/reconnect', async (c) => {
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
app.get('/api/devices/:id/qr', async (c) => {
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

// ── Auto-Reply Rules ──────────────────────────────────────────────────────────

/** GET /api/auto-reply — list all rules */
app.get('/api/auto-reply', async (c) => {
  const { data, error } = await supabase
    .from('auto_reply_rules')
    .select('*')
    .order('created_at', { ascending: true })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data || [])
})

/** POST /api/auto-reply — create a rule */
app.post('/api/auto-reply', async (c) => {
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
app.put('/api/auto-reply/:id', async (c) => {
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
app.delete('/api/auto-reply/:id', async (c) => {
  const id = Number(c.req.param('id'))

  const { error } = await supabase
    .from('auto_reply_rules')
    .delete()
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)

  invalidateRulesCache()
  return c.json({ ok: true })
})

// ── Messaging ─────────────────────────────────────────────────────────────────

/** POST /api/send-message — single message (for external integrations) */
app.post('/api/send-message', async (c) => {
  const body = await c.req.json<{
    deviceId: string
    to: string
    message: string
  }>()

  if (!body.deviceId || !body.to || !body.message) {
    return c.json({ error: 'deviceId, to, and message are required' }, 400)
  }

  const sock = getSocket(body.deviceId)
  if (!sock) {
    return c.json({ error: `Device ${body.deviceId} is not connected` }, 503)
  }

  const digits = body.to.replace(/\D/g, '')
  const cleaned = digits.startsWith('0') ? '62' + digits.slice(1) : digits
  const jid = `${cleaned}@s.whatsapp.net`

  try {
    await sock.sendMessage(jid, { text: body.message })
    return c.json({ ok: true, to: jid })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

// ── Blast Queue ───────────────────────────────────────────────────────────────

/** POST /api/blast — start a mass blast */
app.post('/api/blast', async (c) => {
  const body = await c.req.json<{
    deviceId: string
    numbers: string[]
    message: string
    delay?: number
  }>()

  if (!body.deviceId || !body.numbers?.length || !body.message) {
    return c.json({ error: 'deviceId, numbers, and message are required' }, 400)
  }

  const sock = getSocket(body.deviceId)
  if (!sock) {
    return c.json({ error: `Device ${body.deviceId} is not connected` }, 503)
  }

  const blastId = startBlast({
    deviceId: body.deviceId,
    numbers: body.numbers,
    message: body.message,
    delay: body.delay ?? 7,
  })

  return c.json({ ok: true, blastId }, 202)
})

/** GET /api/blast — list recent blasts */
app.get('/api/blast', (c) => {
  return c.json(getAllBlasts())
})

/** GET /api/blast/:id/status — get blast progress */
app.get('/api/blast/:id/status', (c) => {
  const blastId = c.req.param('id')
  const job = getBlastStatus(blastId)
  if (!job) return c.json({ error: 'Blast not found' }, 404)
  return c.json(job)
})

/** DELETE /api/blast/:id — stop a running blast */
app.delete('/api/blast/:id', (c) => {
  const blastId = c.req.param('id')
  const stopped = stopBlast(blastId)
  if (!stopped) return c.json({ error: 'Blast not found or already finished' }, 404)
  return c.json({ ok: true })
})

// ── Root ──────────────────────────────────────────────────────────────────────

app.get('/', (c) =>
  c.json({ name: 'WA Gateway API', version: '1.0.0', docs: '/api/health' })
)

// ── Server startup ────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 3000

serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`\n🚀  WA Gateway API running on http://localhost:${info.port}`)
  console.log(`    CORS origin: ${corsOrigin}\n`)

  // Restore persisted sessions from Supabase on boot
  await restoreSessions()
})
