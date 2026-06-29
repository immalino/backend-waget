import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env')
}

// Admin/service client — used for DB operations (bypasses RLS)
export const supabase = createClient(supabaseUrl, supabaseSecretKey)

// Auth client — used for user sign-in/sign-out (uses publishable/anon key)
export const supabaseAuth = createClient(
  supabaseUrl,
  supabasePublishableKey || supabaseSecretKey
)
