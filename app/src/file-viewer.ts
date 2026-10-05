export type FileViewerFormat = 'pdf' | 'office' | 'archive' | 'email' | 'ebook' | 'drawing' | 'cad' | 'model' | 'gis' | 'asset'

const formats: ReadonlyArray<readonly [FileViewerFormat, readonly string[]]> = [
  ['pdf', ['pdf']],
  ['office', ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt', 'fodt', 'wps',
    'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'ods', 'fods', 'numbers', 'et',
    'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'potx', 'potm', 'odp', 'fodp', 'key', 'dps']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']],
  ['email', ['eml', 'msg', 'mbox']],
  ['ebook', ['epub', 'ofd', 'xps', 'oxps']],
  ['drawing', ['drawio', 'dio', 'excalidraw', 'tldraw']],
  ['cad', ['dxf', 'dwg', 'dwf', 'step', 'stp', 'iges', 'igs', 'ifc', 'sat', 'sab', 'x_t', 'x_b',
    '3dm', 'skp', 'sldprt', 'sldasm', 'gds', 'gdsii', 'oas', 'oasis']],
  ['model', ['gltf', 'glb', 'obj', 'stl', 'fbx', 'dae', 'ply', '3mf', '3ds', 'usd', 'usda', 'usdc', 'usdz', 'wrl', 'vrml']],
  ['gis', ['geojson', 'topojson', 'kml', 'kmz', 'gpx', 'shp']],
  ['asset', ['ttf', 'otf', 'woff', 'woff2', 'eot', 'psd', 'psb', 'ai', 'eps', 'ps', 'webarchive', 'sqlite', 'sqlite3', 'db', 'wasm', 'parquet', 'avro']],
]

const extensions = new Map<string, FileViewerFormat>(formats.flatMap(([format, values]) => values.map(ext => [`.${ext}`, format] as const)))

/** Preserve Shadow's source selection, Markdown, HTML and image annotation paths. */
export function fileViewerFormat(ext: string): FileViewerFormat | undefined {
  return extensions.get(ext.toLowerCase())
}
