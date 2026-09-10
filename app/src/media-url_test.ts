import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { buildMediaUrl, chatIdForMediaSession } from './media-url.ts'

test('media URL maps and encodes the direct web chat identity and path', () => {
  assertEquals(chatIdForMediaSession('web:chat-a/b ?'), 'chat-a/b ?')
  assertEquals(
    buildMediaUrl(
      'http://localhost:5173/nested/',
      'web:chat-a/b ?',
      'outputs/image one&two.png',
    ),
    'http://localhost:5173/api/media?chatId=chat-a%2Fb+%3F&path=outputs%2Fimage+one%26two.png',
  )
})

test('media URL rejects non-web sessions and preserves remote URLs', () => {
  assertEquals(chatIdForMediaSession('discord:channel-1'), null)
  assertEquals(chatIdForMediaSession('web:readonly-import'), null)
  assertEquals(
    buildMediaUrl('http://localhost:5173', 'discord:channel-1', 'image.png'),
    null,
  )
  assertEquals(
    buildMediaUrl(
      'http://localhost:5173',
      'discord:channel-1',
      'https://example.com/image one.png',
    ),
    'https://example.com/image one.png',
  )
})