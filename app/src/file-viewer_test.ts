import assert from 'node:assert/strict'
import test from 'node:test'
import { fileViewerFormat } from './file-viewer.ts'

test('Open File Viewer routing expands formats without taking existing interactive previews', () => {
  for (const [ext, format] of [
    ['.PDF', 'pdf'], ['.docx', 'office'], ['.xls', 'office'], ['.pptx', 'office'],
    ['.zip', 'archive'], ['.7z', 'archive'], ['.eml', 'email'], ['.msg', 'email'],
    ['.epub', 'ebook'], ['.ofd', 'ebook'], ['.xps', 'ebook'],
    ['.drawio', 'drawing'], ['.excalidraw', 'drawing'],
    ['.glb', 'model'], ['.stl', 'model'], ['.dxf', 'cad'], ['.dwg', 'cad'], ['.gds', 'cad'],
    ['.geojson', 'gis'], ['.kmz', 'gis'], ['.shp', 'gis'],
    ['.psd', 'asset'], ['.woff2', 'asset'], ['.parquet', 'asset'], ['.webarchive', 'asset'],
  ]) assert.equal(fileViewerFormat(ext!), format)
  for (const ext of ['', '.custom', '.txt', '.md', '.markdown', '.jsonl', '.csv', '.tsv',
    '.html', '.htm', '.png', '.svg', '.jpg', '.mp4', '.mp3', '.xmind', '.avif', '.tiff', '.heic']) {
    assert.equal(fileViewerFormat(ext), undefined, ext)
  }
})
