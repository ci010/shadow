import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { buildMediaUrl, chatIdForMediaSession } from './media-url.ts'

test('Project coordination media uses the canonical chat and stays Project-scoped', () => {
  assertEquals(chatIdForMediaSession('web:chat-admin'), 'chat-admin')
  assertEquals(buildMediaUrl('http://fixture/projects/a/', 'web:chat-admin', 'outputs/diagram.png'),
    'http://fixture/projects/a/api/media?chatId=chat-admin&path=outputs%2Fdiagram.png')
})

test('media URL maps and encodes the direct web chat identity and path', () => {
  assertEquals(chatIdForMediaSession('web:chat-a/b ?'), 'chat-a/b ?')
  assertEquals(
    buildMediaUrl(
      'http://localhost:5173/nested/',
      'web:chat-a/b ?',
      'outputs/image one&two.png',
    ),
    'http://localhost:5173/nested/api/media?chatId=chat-a%2Fb+%3F&path=outputs%2Fimage+one%26two.png',
  )
})

test('media URL addresses SNS and historical sessions by full identity and preserves remote and data URLs', () => {
  assertEquals(chatIdForMediaSession('discord:channel-1'), null)
  assertEquals(chatIdForMediaSession('web:readonly-import'), null)
  assertEquals(
    buildMediaUrl('http://localhost:5173', 'discord:channel-1', 'image.png'),
    'http://localhost:5173/api/media?sessionId=discord%3Achannel-1&path=image.png',
  )
  assertEquals(
    buildMediaUrl(
      'http://localhost:5173',
      'discord:channel-1',
      'https://example.com/image one.png',
    ),
    'https://example.com/image one.png',
  )
  assertEquals(
    buildMediaUrl(
      'http://localhost:5173',
      'web:chat-one',
      'data:image/png;base64,c3ludGhldGlj',
    ),
    'data:image/png;base64,c3ludGhldGlj',
  )
})

test('SNS downloads retain their owning Project and never use a fabricated web identity', () => {
  const url = new URL(buildMediaUrl('http://fixture/projects/a/', 'bot:a:bot-1:qq:group%3Ax', 'uploads/video.mp4', true)!)
  assertEquals(url.pathname, '/projects/a/api/media')
  assertEquals(url.searchParams.get('sessionId'), 'bot:a:bot-1:qq:group%3Ax')
  assertEquals(url.searchParams.get('chatId'), null)
  assertEquals(url.searchParams.get('download'), '1')
})

test('absolute Windows upload paths round-trip unchanged through the media URL', () => {
  for (const path of [
    String.raw`C:\fixtures\private session\uploads\image one&two.png`,
    String.raw`\\fixture-server\share\private session\uploads\image #1.png`,
  ]) {
    const url = new URL(buildMediaUrl('http://localhost:5173', 'web:chat-upload-fixture', path)!)
    assertEquals(url.origin, 'http://localhost:5173')
    assertEquals(url.pathname, '/api/media')
    assertEquals(url.searchParams.get('chatId'), 'chat-upload-fixture')
    assertEquals(url.searchParams.get('path'), path)
  }
})

test('non-image data URLs cannot become attachment links', () => {
  assertEquals(buildMediaUrl('http://localhost:5173', 'web:chat-one', 'data:text/html,<script>alert(1)</script>'), null)
})