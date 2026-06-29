import type { WASocket, WAMessage } from 'baileys'
import { supabase } from './supabase.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface AutoReplyRule {
  id: number
  keyword: string
  response: string
  sender_id: string  // 'All' or a specific phone number
  enabled: boolean
}

// ── In-memory rules cache ────────────────────────────────────────────────────

let rulesCache: AutoReplyRule[] = []
let cacheExpiry = 0
const CACHE_TTL_MS = 60_000  // refresh every 60 seconds

async function getRules(): Promise<AutoReplyRule[]> {
  if (Date.now() < cacheExpiry && rulesCache.length > 0) {
    return rulesCache
  }

  const { data, error } = await supabase
    .from('auto_reply_rules')
    .select('*')
    .eq('enabled', true)

  if (error) {
    console.error('Failed to fetch auto-reply rules:', error.message)
    return rulesCache // return stale cache on error
  }

  rulesCache = (data as AutoReplyRule[]) || []
  cacheExpiry = Date.now() + CACHE_TTL_MS
  return rulesCache
}

/** Force-refresh the rules cache (called after CRUD operations) */
export function invalidateRulesCache(): void {
  cacheExpiry = 0
}

// ── Setup per-session listener ───────────────────────────────────────────────

export function setupAutoReply(deviceId: string, sock: WASocket): void {
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      await handleIncomingMessage(deviceId, sock, msg)
    }
  })
}

async function handleIncomingMessage(
  deviceId: string,
  sock: WASocket,
  msg: WAMessage
): Promise<void> {
  // Ignore messages from us, status broadcasts, and protocol messages
  if (msg.key.fromMe) return
  if (!msg.message) return
  if (msg.key.remoteJid === 'status@broadcast') return

  // Extract text content from various message types
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    ''

  if (!text) return

  const lowerText = text.toLowerCase()

  // Get the phone number for this device
  const deviceNumber = sock.user?.id?.split(':')[0] || null

  // Fetch rules and check for keyword matches
  const rules = await getRules()

  for (const rule of rules) {
    // Check if rule applies to this device
    const ruleApplies =
      rule.sender_id === 'All' ||
      rule.sender_id === deviceNumber

    if (!ruleApplies) continue

    // Case-insensitive keyword match (checks if the keyword appears in the message)
    if (lowerText.includes(rule.keyword.toLowerCase())) {
      try {
        await sock.sendMessage(msg.key.remoteJid!, {
          text: rule.response,
        })
        console.log(
          `[${deviceId}] Auto-reply sent for keyword "${rule.keyword}" to ${msg.key.remoteJid}`
        )
      } catch (err) {
        console.error(
          `[${deviceId}] Failed to send auto-reply:`,
          (err as Error).message
        )
      }
      // Only reply with the first matching rule to avoid spamming
      break
    }
  }
}
