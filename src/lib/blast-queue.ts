import { getSocket } from './session-manager.js'
import { supabase } from './supabase.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface BlastJob {
  id: string
  deviceId: string
  numbers: string[]
  message: string
  delay: number       // base delay in seconds
  status: 'running' | 'completed' | 'stopped'
  sent: number
  failed: number
  total: number
  logs: Array<{ num: string; ok: boolean; time: string; error?: string }>
  aborted: boolean
}

// ── State ────────────────────────────────────────────────────────────────────

const blasts = new Map<string, BlastJob>()
let nextId = 1

// ── Public API ───────────────────────────────────────────────────────────────

/** Start a new blast job. Returns the blast ID. */
export function startBlast(params: {
  deviceId: string
  numbers: string[]
  message: string
  delay?: number  // base delay in seconds (default 7)
}): string {
  const { deviceId, numbers, message, delay = 7 } = params

  const id = `blast-${nextId++}`

  const job: BlastJob = {
    id,
    deviceId,
    numbers: [...numbers],
    message,
    delay,
    status: 'running',
    sent: 0,
    failed: 0,
    total: numbers.length,
    logs: [],
    aborted: false,
  }

  blasts.set(id, job)

  // Start the async send loop (fire-and-forget)
  processBlast(job).catch((err) =>
    console.error(`[Blast ${id}] Unexpected error:`, err.message)
  )

  return id
}

/** Get current blast progress */
export function getBlastStatus(blastId: string): BlastJob | undefined {
  return blasts.get(blastId)
}

/** Stop a running blast */
export function stopBlast(blastId: string): boolean {
  const job = blasts.get(blastId)
  if (!job || job.status !== 'running') return false
  job.aborted = true
  job.status = 'stopped'
  return true
}

/** Get all blast jobs (recent 20) */
export function getAllBlasts(): Array<Omit<BlastJob, 'logs'>> {
  return Array.from(blasts.values())
    .slice(-20)
    .map(({ logs, ...rest }) => rest)
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function processBlast(job: BlastJob): Promise<void> {
  const sock = getSocket(job.deviceId)
  if (!sock) {
    job.status = 'stopped'
    console.error(`[Blast ${job.id}] Device ${job.deviceId} not connected.`)
    return
  }

  for (let i = 0; i < job.numbers.length; i++) {
    if (job.aborted) break

    const num = job.numbers[i]
    const jid = formatJid(num)
    const timestamp = new Date().toISOString()

    try {
      await sock.sendMessage(jid, { text: job.message })
      job.sent++
      job.logs.unshift({ num, ok: true, time: timestamp })

      // Log to Supabase (fire-and-forget, don't block the loop)
      void Promise.resolve(
        supabase.from('blast_logs').insert({
          device_id: job.deviceId,
          recipient: num,
          message: job.message,
          status: 'sent',
          sent_at: timestamp,
        })
      ).catch(() => {})

    } catch (err) {
      job.failed++
      const errMsg = (err as Error).message
      job.logs.unshift({ num, ok: false, time: timestamp, error: errMsg })

      // Log failure to Supabase
      void Promise.resolve(
        supabase.from('blast_logs').insert({
          device_id: job.deviceId,
          recipient: num,
          message: job.message,
          status: 'failed',
          sent_at: timestamp,
        })
      ).catch(() => {})
    }

    // Anti-ban delay: base delay + random jitter (0–3s)
    if (i < job.numbers.length - 1 && !job.aborted) {
      const jitter = Math.random() * 3000
      const waitMs = job.delay * 1000 + jitter
      await sleep(waitMs)
    }
  }

  if (!job.aborted) {
    job.status = 'completed'
  }

  console.log(
    `[Blast ${job.id}] Finished — sent: ${job.sent}, failed: ${job.failed}, status: ${job.status}`
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a phone number to WhatsApp JID */
function formatJid(num: string): string {
  // Strip non-digit characters
  const digits = num.replace(/\D/g, '')
  // Remove leading '0' if present (Indonesian format)
  const cleaned = digits.startsWith('0') ? '62' + digits.slice(1) : digits
  return `${cleaned}@s.whatsapp.net`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
