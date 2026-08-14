/**
 * Host-side frame codec for the SSH helper protocol. A frame is
 * `<16 hex chars length>\n<JSON payload>\n`; payloads are ASCII (binary as
 * base64), so the shell side can `read -N` them character-for-character.
 * @module @deepseek-ai/dsh-ssh/frames
 */

/**
 * Encode one payload into a frame buffer.
 * @param payload - JSON payload text without framing.
 * @returns the complete UTF-8 protocol frame.
 */
export function encodeFrame(payload: string): Buffer {
  return Buffer.from(`${payload.length.toString(16).padStart(16, '0')}\n${payload}\n`, 'utf8')
}

/** Incremental decoder for an incoming frame stream. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * Feed a chunk of stream bytes and return every complete frame found.
   * @param chunk - newly received protocol bytes.
   * @returns decoded payloads completed by this chunk.
   */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const frames: string[] = []
    while (true) {
      // Banner/plain lines can precede the first frame; skip lines that are
      // not 16-hex-digit prefixes (the caller validates banner separately).
      const newline = this.buffer.indexOf(0x0A)
      if (newline < 0) return frames
      const head = this.buffer.subarray(0, newline)
      if (head.length !== 16 || !/^[0-9a-f]{16}$/.test(head.toString('utf8'))) {
        // Not a frame prefix: consume as a plain line (banner or noise).
        this.buffer = this.buffer.subarray(newline + 1)
        continue
      }
      const length = Number.parseInt(head.toString('utf8'), 16)
      if (this.buffer.length < newline + 1 + length + 1) return frames
      const payload = this.buffer.subarray(newline + 1, newline + 1 + length)
      if (this.buffer[newline + 1 + length] !== 0x0A) {
        throw new Error('ssh helper frame: missing terminating newline')
      }
      frames.push(payload.toString('utf8'))
      this.buffer = this.buffer.subarray(newline + 1 + length + 1)
    }
  }
}
