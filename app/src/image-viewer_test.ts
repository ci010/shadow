import assert from 'node:assert/strict'
import test from 'node:test'
import { isPreviewImageUrl } from './image-viewer.ts'

test('image preview accepts displayable web and local preview URLs, not navigation schemes', () => {
  for (const src of ['https://example.test/image.png', 'http://localhost/api/media?path=image.png', 'data:image/png;base64,AA==', 'blob:http://localhost/fixture']) {
    assert.equal(isPreviewImageUrl(src), true)
  }
  for (const src of ['', 'javascript:alert(1)', 'file:///private/image.png', 'data:text/html,<p>HTML</p>']) {
    assert.equal(isPreviewImageUrl(src), false)
  }
})
