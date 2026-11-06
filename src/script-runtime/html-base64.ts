// Private guest-only base64 decoder for Cheerio's generated entity table.
// esbuild injects this binding; it is not exported by @shadow/html.
export function atob(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let bits = 0, value = 0, result = ''
  for (const char of input) {
    if (char === '=') break
    const digit = alphabet.indexOf(char)
    if (digit < 0) continue
    value = (value << 6) | digit
    bits += 6
    if (bits >= 8) { bits -= 8; result += String.fromCharCode((value >> bits) & 255) }
  }
  return result
}
