import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type ConnectionState,
} from 'baileys'
import { Boom } from '@hapi/boom'
import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs/promises'
import pino from 'pino'
import { supabase } from './supabase.js'
import { setupAutoReply } from './auto-reply.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionInfo {
  socket: WASocket
  status: 'connecting' | 'connected' | 'disconnected'
  qr: string | null
  number: string | null
}

// ── Module state ─────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionInfo>()
export const sessionEvents = new EventEmitter()

const SESSIONS_DIR = path.resolve('sessions')
const logger = pino({ level: 'error' })

// ── Public API ───────────────────────────────────────────────────────────────

/** Start (or restart) a Baileys session for a device */
export async function startSession(deviceId: string): Promise<void> {
  // Prevent duplicate sessions
  if (sessions.has(deviceId)) {
    const existing = sessions.get(deviceId)!
    if (existing.status === 'connected' || existing.status === 'connecting') {
      return
    }
  }

  const sessionDir = path.join(SESSIONS_DIR, deviceId)
  await fs.mkdir(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

  const sock = makeWASocket({
    auth: state,
    logger: logger.child({ session: deviceId }),
    browser: ['WA-Gateway', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60_000,
    qrTimeout: 60_000,
  })

  const info: SessionInfo = {
    socket: sock,
    status: 'connecting',
    qr: null,
    number: null,
  }
  sessions.set(deviceId, info)

  // ── Credential updates ──
  sock.ev.on('creds.update', saveCreds)

  // ── Connection lifecycle ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update

    // QR code received
    if (qr) {
      info.qr = qr
      info.status = 'connecting'
      sessionEvents.emit(`qr:${deviceId}`, qr)
      await syncDeviceStatus(deviceId, 'pending', null)
    }

    // Connected
    if (connection === 'open') {
      info.status = 'connected'
      info.qr = null

      // Extract phone number from socket
      const phoneNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || null
      info.number = phoneNumber

      sessionEvents.emit(`status:${deviceId}`, 'connected')
      await syncDeviceStatus(deviceId, 'connected', phoneNumber)

      // Set up auto-reply listener
      setupAutoReply(deviceId, sock)

      console.log(`[${deviceId}] Connected as ${phoneNumber}`)
    }

    // Disconnected
    if (connection === 'close') {
      info.status = 'disconnected'
      info.qr = null

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      sessionEvents.emit(`status:${deviceId}`, 'disconnected')
      await syncDeviceStatus(deviceId, 'disconnected', info.number)

      if (loggedOut) {
        // User logged out — clean up auth files
        console.log(`[${deviceId}] Logged out. Removing session files.`)
        sessions.delete(deviceId)
        await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {})
      } else {
        // Unexpected disconnect — auto-reconnect after a delay
        console.log(`[${deviceId}] Disconnected (code ${statusCode}). Reconnecting in 3s…`)
        sessions.delete(deviceId)
        setTimeout(() => {
          startSession(deviceId).catch(console.error)
        }, 3000)
      }
    }
  })
}

/** Gracefully stop a session without removing auth files */
export async function stopSession(deviceId: string): Promise<void> {
  const info = sessions.get(deviceId)
  if (!info) return
  try {
    info.socket.end(undefined)
  } catch {
    // ignore
  }
  sessions.delete(deviceId)
  await syncDeviceStatus(deviceId, 'disconnected', info.number)
}

/** Remove a session completely (stop + delete auth files + delete DB row) */
export async function removeSession(deviceId: string): Promise<void> {
  await stopSession(deviceId)
  const sessionDir = path.join(SESSIONS_DIR, deviceId)
  await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {})
  await supabase.from('devices').delete().eq('id', deviceId)
}

/** Get a live WASocket by device ID (for sending messages) */
export function getSocket(deviceId: string): WASocket | null {
  const info = sessions.get(deviceId)
  return info?.status === 'connected' ? info.socket : null
}

/** Get session info for a device */
export function getSessionInfo(deviceId: string): SessionInfo | undefined {
  return sessions.get(deviceId)
}

/** Get all sessions as a plain array */
export function getAllSessions(): Array<{
  id: string
  status: string
  qr: string | null
  number: string | null
}> {
  return Array.from(sessions.entries()).map(([id, info]) => ({
    id,
    status: info.status,
    qr: info.qr,
    number: info.number,
  }))
}

/** Restore sessions from the DB on server boot */
export async function restoreSessions(): Promise<void> {
  const { data: devices, error } = await supabase
    .from('devices')
    .select('id')

  if (error) {
    console.error('Failed to fetch devices from Supabase:', error.message)
    return
  }

  if (!devices || devices.length === 0) {
    console.log('No devices to restore.')
    return
  }

  console.log(`Restoring ${devices.length} session(s)…`)

  for (const device of devices) {
    // Only restore if auth files exist on disk
    const sessionDir = path.join(SESSIONS_DIR, device.id)
    try {
      await fs.access(sessionDir)
      startSession(device.id).catch((err) =>
        console.error(`Failed to restore session ${device.id}:`, err.message)
      )
    } catch {
      // No auth files — skip (user will need to re-scan QR)
      console.log(`[${device.id}] No session files found, skipping.`)
      await syncDeviceStatus(device.id, 'disconnected', null)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function syncDeviceStatus(
  deviceId: string,
  status: string,
  number: string | null
): Promise<void> {
  const { error } = await supabase
    .from('devices')
    .update({
      status,
      number,
      last_seen: new Date().toISOString(),
    })
    .eq('id', deviceId)

  if (error) {
    console.error(`[${deviceId}] Failed to sync status to Supabase:`, error.message)
  }
}
