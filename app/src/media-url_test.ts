import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { buildMediaUrl, chatIdForMediaSession } from './media-url.ts'

test('Project coordination media uses the canonical chat and stays Project-scoped', () => {
  assertEquals(chatIdForMediaSession('web:orchestrator'), 'orchestrator')
  assertEquals(buildMediaUrl('http://fixture/projects/a/', 'web:orchestrator', 'outputs/diagram.png'),
    'http://fixture/projects/a/api/media?chatId=orchestrator&path=outputs%2Fdiagram.png')
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

test('media URL rejects non-web sessions and preserves remote and data URLs', () => {
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
  assertEquals(
    buildMediaUrl(
      'http://localhost:5173',
      'web:chat-one',
      'data:image/png;base64,c3ludGhldGlj',
    ),
    'data:image/png;base64,c3ludGhldGlj',
  )
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