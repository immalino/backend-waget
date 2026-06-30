import { supabase } from './supabase.js'
import { getSocket } from './session-manager.js'

let intervalId: NodeJS.Timeout | null = null
const POLL_INTERVAL_MS = 30_000 // Check every 30 seconds

// Guess mimetype from extension for document sending
function getMimeTypeFromExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const mimeTypes: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    txt: 'text/plain',
    csv: 'text/csv'
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

function getNextScheduledDate(current: Date, repeat: string): Date {
  const next = new Date(current)
  if (repeat === 'daily') {
    next.setDate(next.getDate() + 1)
  } else if (repeat === 'weekly') {
    next.setDate(next.getDate() + 7)
  } else if (repeat === 'monthly') {
    next.setMonth(next.getMonth() + 1)
  }
  return next
}

async function processScheduledMessages() {
  const now = new Date().toISOString()

  // Query pending messages due to be sent
  const { data: messages, error } = await supabase
    .from('scheduled_messages')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', now)

  if (error) {
    console.error('[SCHEDULER] Failed to query pending messages:', error.message)
    return
  }

  if (!messages || messages.length === 0) return

  console.log(`[SCHEDULER] Found ${messages.length} due message(s) to process.`)

  for (const msg of messages) {
    const { id, device_id, to, message, media_url, media_type, repeat, scheduled_at } = msg
    const timestamp = new Date().toISOString()

    try {
      const sock = getSocket(device_id)
      if (!sock) {
        throw new Error(`Device ${device_id} is not connected`)
      }

      const digits = to.replace(/\D/g, '')
      const cleaned = digits.startsWith('0') ? '62' + digits.slice(1) : digits
      const jid = `${cleaned}@s.whatsapp.net`

      // Determine payload structure
      let payload: any = {}
      if (media_url) {
        const type = media_type || (media_url.match(/\.(jpg|jpeg|png|gif|webp)/i) ? 'image' : 'document')
        if (type === 'image') {
          payload = { image: { url: media_url }, caption: message }
        } else if (type === 'video') {
          payload = { video: { url: media_url }, caption: message }
        } else if (type === 'audio') {
          payload = { audio: { url: media_url } }
        } else {
          payload = {
            document: { url: media_url },
            mimetype: getMimeTypeFromExtension(media_url),
            fileName: media_url.split('/').pop() || 'document',
            caption: message
          }
        }
      } else {
        payload = { text: message }
      }

      // Send via Baileys
      await sock.sendMessage(jid, payload)

      // Update current message as sent
      await supabase
        .from('scheduled_messages')
        .update({
          status: 'sent',
          last_sent_at: timestamp
        })
        .eq('id', id)

      console.log(`[SCHEDULER] Successfully sent scheduled message ${id} to ${to}`)

      // Handle repeating schedule
      if (repeat && ['daily', 'weekly', 'monthly'].includes(repeat)) {
        const nextDate = getNextScheduledDate(new Date(scheduled_at), repeat)
        const { error: insertError } = await supabase
          .from('scheduled_messages')
          .insert({
            device_id,
            to,
            message,
            media_url,
            media_type,
            repeat,
            scheduled_at: nextDate.toISOString(),
            status: 'pending'
          })

        if (insertError) {
          console.error(`[SCHEDULER] Failed to insert next repeating message occurrence:`, insertError.message)
        } else {
          console.log(`[SCHEDULER] Scheduled next occurrence of repeating message ${id} for ${nextDate.toISOString()}`)
        }
      }

    } catch (err) {
      const errMsg = (err as Error).message
      console.error(`[SCHEDULER] Failed to process scheduled message ${id}:`, errMsg)

      // Mark as failed in DB
      await supabase
        .from('scheduled_messages')
        .update({
          status: 'failed'
        })
        .eq('id', id)
    }
  }
}

export function startScheduler() {
  if (intervalId) return
  console.log('[SCHEDULER] Background scheduler started.')
  intervalId = setInterval(() => {
    processScheduledMessages().catch((err) => {
      console.error('[SCHEDULER] Unexpected error in poll loop:', err)
    })
  }, POLL_INTERVAL_MS)
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    console.log('[SCHEDULER] Background scheduler stopped.')
  }
}
