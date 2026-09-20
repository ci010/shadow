import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Bus } from '../bus/bus.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { QQChannel } from './qq.ts'

test('QQ sends a local file from the originating group session', async () => {
  await withTempWorkspace(async (workspace) => {
    const chatId = 'group:group-openid'
    const sessionDir = sessionWorkspacePath(workspace, `qq:${chatId}`)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'report.txt'), 'report contents')

    const originalFetch = globalThis.fetch
    const requests: Array<
      { method: string; path: string; body?: Record<string, unknown> }
    > = []
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.href === 'https://bots.qq.com/app/getAppAccessToken') {
        return Response.json({ access_token: 'access-token', expires_in: 7200 })
      }

      if (url.href === 'https://upload.example.test/part-0') {
        requests.push({ method: init?.method ?? 'GET', path: url.pathname })
        return new Response(null, { status: 200 })
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ method: init?.method ?? 'GET', path: url.pathname, body })
      if (url.pathname.endsWith('/upload_prepare')) {
        return Response.json({
          upload_id: 'upload-id',
          block_size: 1024,
          parts: [{
            index: 0,
            presigned_url: 'https://upload.example.test/part-0',
          }],
        })
      }
      if (url.pathname.endsWith('/files')) {
        return Response.json({ file_info: 'file-info' })
      }
      return Response.json({ id: 'message-id' })
    }

    try {
      const channel = new QQChannel(new Bus(), {
        appId: 'app-id',
        secret: 'app-secret',
        workspace,
      })
      channel.setReceiver(async message => ({
        status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId,
      }))
      await (channel as unknown as {
        handleDispatch(event: string, data: Record<string, unknown>): Promise<void>
      }).handleDispatch('GROUP_AT_MESSAGE_CREATE', {
        id: 'source-id', group_openid: 'group-openid', author: { member_openid: 'sender' },
        content: 'report', timestamp: new Date().toISOString(),
      })
      await channel.send({
        channel: 'qq',
        chatId,
        event: 'response',
        content: '',
        media: ['report.txt'],
        done: true,
        replyTo: 'source-id',
      })

      assertEquals(requests, [
        {
          method: 'POST',
          path: '/v2/groups/group-openid/upload_prepare',
          body: {
            file_type: 4,
            file_name: 'report.txt',
            file_size: 15,
            md5: createHash('md5').update('report contents').digest('hex'),
            sha1: createHash('sha1').update('report contents').digest('hex'),
            md5_10m: createHash('md5').update('report contents').digest('hex'),
          },
        },
        { method: 'PUT', path: '/part-0' },
        {
          method: 'POST',
          path: '/v2/groups/group-openid/upload_part_finish',
          body: {
            upload_id: 'upload-id',
            part_index: 0,
            block_size: 15,
            md5: createHash('md5').update('report contents').digest('hex'),
          },
        },
        {
          method: 'POST',
          path: '/v2/groups/group-openid/files',
          body: {
            upload_id: 'upload-id',
          },
        },
        {
          method: 'POST',
          path: '/v2/groups/group-openid/messages',
          body: {
            msg_type: 7,
            msg_seq: 1,
            msg_id: 'source-id',
            media: { file_info: 'file-info' },
          },
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
