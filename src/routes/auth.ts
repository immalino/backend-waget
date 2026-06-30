import { Hono } from 'hono'
import { supabase, supabaseAuth } from '../lib/supabase.js'
import { authMiddleware } from '../lib/auth-middleware.js'

type Variables = {
  userId: string
  userEmail: string
}

export const authRouter = new Hono<{ Variables: Variables }>()

/** POST /api/auth/login — sign in with email + password via Supabase Auth */
authRouter.post('/login', async (c) => {
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
authRouter.post('/logout', authMiddleware, async (c) => {
  const authHeader = c.req.header('Authorization')!
  const token = authHeader.slice(7)

  // Sign out from Supabase (invalidates the refresh token server-side)
  await supabaseAuth.auth.admin.signOut(token).catch(() => null)

  return c.json({ ok: true })
})

/** GET /api/auth/me — return current user info from JWT */
authRouter.get('/me', authMiddleware, (c) => {
  return c.json({
    id: c.get('userId'),
    email: c.get('userEmail'),
  })
})

/** PUT /api/auth/profile — update current user name and email */
authRouter.put('/profile', authMiddleware, async (c) => {
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
authRouter.put('/password', authMiddleware, async (c) => {
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
