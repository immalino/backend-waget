import { Hono } from 'hono'
import { getSocket } from '../lib/session-manager.js'
import {
  startBlast,
  getBlastStatus,
  stopBlast,
  getAllBlasts,
} from '../lib/blast-queue.js'

type Variables = {
  userId: string
  userEmail: string
}

export const messagesRouter = new Hono<{ Variables: Variables }>()

/** POST /api/send-message — single message (for external integrations) */
messagesRouter.post('/send-message', async (c) => {
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

// Helper to guess mimetype from extension for document sending
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

/** POST /api/send-media — send image, video, audio, or document (for external integrations) */
messagesRouter.post('/send-media', async (c) => {
  let deviceId: string | undefined
  let to: string | undefined
  let mediaUrl: string | undefined
  let mediaType: 'image' | 'video' | 'audio' | 'document' | undefined
  let caption: string | undefined
  let fileName: string | undefined
  let fileBuffer: Buffer | undefined
  let fileMimetype: string | undefined

  const contentType = c.req.header('content-type') || ''

  try {
    if (contentType.includes('application/json')) {
      const body = await c.req.json<{
        deviceId: string
        to: string
        mediaUrl?: string
        mediaType?: 'image' | 'video' | 'audio' | 'document'
        caption?: string
        fileName?: string
      }>()
      deviceId = body.deviceId
      to = body.to
      mediaUrl = body.mediaUrl
      mediaType = body.mediaType
      caption = body.caption
      fileName = body.fileName
    } else {
      const body = await c.req.parseBody()
      deviceId = body.deviceId as string
      to = body.to as string
      mediaUrl = body.mediaUrl as string
      mediaType = body.mediaType as any
      caption = body.caption as string
      fileName = body.fileName as string

      const file = body.file
      if (file && typeof file !== 'string') {
        fileMimetype = file.type
        fileBuffer = Buffer.from(await file.arrayBuffer())
        if (!fileName) {
          fileName = file.name
        }
      }
    }

    if (!deviceId || !to) {
      return c.json({ error: 'deviceId and to are required' }, 400)
    }

    if (!fileBuffer && !mediaUrl) {
      return c.json({ error: 'Either file upload or mediaUrl is required' }, 400)
    }

    const sock = getSocket(deviceId)
    if (!sock) {
      return c.json({ error: `Device ${deviceId} is not connected` }, 503)
    }

    const digits = to.replace(/\D/g, '')
    const cleaned = digits.startsWith('0') ? '62' + digits.slice(1) : digits
    const jid = `${cleaned}@s.whatsapp.net`

    let source: any
    if (fileBuffer) {
      source = fileBuffer
    } else if (mediaUrl) {
      source = { url: mediaUrl }
    }

    if (!mediaType) {
      const targetUrlOrName = mediaUrl || fileName || ''
      const ext = targetUrlOrName.split('.').pop()?.toLowerCase() || ''
      if (fileMimetype) {
        if (fileMimetype.startsWith('image/')) mediaType = 'image'
        else if (fileMimetype.startsWith('video/')) mediaType = 'video'
        else if (fileMimetype.startsWith('audio/')) mediaType = 'audio'
        else mediaType = 'document'
      } else {
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) mediaType = 'image'
        else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) mediaType = 'video'
        else if (['mp3', 'ogg', 'wav', 'aac', 'm4a'].includes(ext)) mediaType = 'audio'
        else mediaType = 'document'
      }
    }

    let messagePayload: any = {}
    if (mediaType === 'image') {
      messagePayload = { image: source, caption }
    } else if (mediaType === 'video') {
      messagePayload = { video: source, caption }
    } else if (mediaType === 'audio') {
      messagePayload = { audio: source }
    } else {
      messagePayload = {
        document: source,
        mimetype: fileMimetype || getMimeTypeFromExtension(mediaUrl || fileName || ''),
        fileName: fileName || 'document',
        caption
      }
    }

    await sock.sendMessage(jid, messagePayload)
    return c.json({ ok: true, to: jid, mediaType })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500)
  }
})

/** POST /api/blast — start a mass blast */
messagesRouter.post('/blast', async (c) => {
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
messagesRouter.get('/blast', (c) => {
  return c.json(getAllBlasts())
})

/** GET /api/blast/:id/status — get blast progress */
messagesRouter.get('/blast/:id/status', (c) => {
  const blastId = c.req.param('id')
  const job = getBlastStatus(blastId)
  if (!job) return c.json({ error: 'Blast not found' }, 404)
  return c.json(job)
})

/** DELETE /api/blast/:id — stop a running blast */
messagesRouter.delete('/blast/:id', (c) => {
  const blastId = c.req.param('id')
  const stopped = stopBlast(blastId)
  if (!stopped) return c.json({ error: 'Blast not found or already finished' }, 404)
  return c.json({ ok: true })
})
