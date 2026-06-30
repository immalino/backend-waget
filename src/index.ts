import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { restoreSessions, getAllSessions } from './lib/session-manager.js'
import { authMiddleware } from './lib/auth-middleware.js'

// Import Routers
import { authRouter } from './routes/auth.js'
import { devicesRouter } from './routes/devices.js'
import { autoReplyRouter } from './routes/auto-reply.js'
import { messagesRouter } from './routes/messages.js'

// ── App Initialization ───────────────────────────────────────────────────────

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

// CORS configuration supporting local dev and Vercel production preview domains
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

// ── Global Auth Guard Middleware ──────────────────────────────────────────────

app.use('/api/*', async (c, next) => {
  // Skip auth for health, auth router, and QR SSE streams (which use query param auth)
  const path = c.req.path
  if (
    path === '/api/health' ||
    path.startsWith('/api/auth/') ||
    (path.startsWith('/api/devices/') && path.endsWith('/qr'))
  ) {
    return next()
  }
  return authMiddleware(c, next)
})

// ── Route Mounts ─────────────────────────────────────────────────────────────

app.route('/api/auth', authRouter)
app.route('/api/devices', devicesRouter)
app.route('/api/auto-reply', autoReplyRouter)
app.route('/api', messagesRouter)

// ── Root Endpoint ────────────────────────────────────────────────────────────

app.get('/', (c) =>
  c.json({ name: 'WA Gateway API', version: '1.0.0', docs: '/api/health' })
)

// ── Server Startup ────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 3000

serve({ fetch: app.fetch, port }, async (info) => {
  console.log(`\n🚀  WA Gateway API running on http://localhost:${info.port}`)
  console.log(`    CORS origin: ${corsOrigin}\n`)

  // Restore persisted sessions from Supabase on boot
  await restoreSessions()
})
