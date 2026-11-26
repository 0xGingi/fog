// Small file helpers for the bot: image sizes (so photos lay out before they load) and EXIF removal
// (so a bot's photos don't carry the camera's location, like photos sent from the app).

/** Width and height of a PNG, JPEG, GIF or WebP, from its header. */
export function imageSize(b: Uint8Array): { w: number; h: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length > 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: v.getUint16(6, true), h: v.getUint16(8, true) }
  if (b.length > 30 && v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    const kind = String.fromCharCode(...b.subarray(12, 16))
    if (kind === 'VP8 ') return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff }
    if (kind === 'VP8L') {
      const n = v.getUint32(21, true)
      return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return
      const marker = b[i + 1]
      const len = v.getUint16(i + 2)
      // Start-of-frame markers carry the size (not DHT/JPG/DAC, which share the range).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) }
      i += 2 + len
    }
  }
}

/** A JPEG without its EXIF/XMP blocks (APP1), where cameras put location and serial numbers. */
export function stripJpegMeta(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const keep: Uint8Array[] = [b.subarray(0, 2)]
  let i = 2
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]
    if (marker === 0xda) break // start of scan: the rest is image data
    const end = i + 2 + v.getUint16(i + 2)
    if (marker !== 0xe1) keep.push(b.subarray(i, end))
    i = end
  }
  keep.push(b.subarray(i))
  const out = new Uint8Array(keep.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of keep) (out.set(p, o), (o += p.length))
  return out
}
