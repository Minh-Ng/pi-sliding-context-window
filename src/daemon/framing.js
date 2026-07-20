import { ContractError } from "../store/store-contract.js";

// Bound encoded transport independently from logical field limits. Ordinary
// maximum store.put content occupies 12 MiB plus bounded envelope overhead;
// heavily escaped JSON that expands toward 72 MiB is rejected before parsing.
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const FRAME_BLOCK_BYTES = 64 * 1024;

/** Split a byte stream into bounded newline-delimited protocol frames. */
export class LineFramer {
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new TypeError("maxFrameBytes must be a positive safe integer.");
    }
    this.maxFrameBytes = maxFrameBytes;
    this.blocks = [];
    this.tail = undefined;
    this.tailLength = 0;
    this.bufferedBytes = 0;
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const lines = [];
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) break;
      const segment = bytes.subarray(start, newline);
      const frameBytes = this.bufferedBytes + segment.length;
      if (frameBytes > this.maxFrameBytes) this.#tooLarge();
      lines.push(this.bufferedBytes === 0 ? segment : this.#materialize(segment, frameBytes));
      this.#reset();
      start = newline + 1;
    }
    const remainder = bytes.subarray(start);
    if (remainder.length > 0) this.#append(remainder);
    return lines;
  }

  finish() {
    if (this.bufferedBytes === 0) return [];
    throw new ContractError("INVALID_REQUEST", "$", "connection ended with an incomplete protocol frame");
  }

  /** Release an incomplete frame without materializing it. */
  discard() {
    const discardedBytes = this.bufferedBytes;
    this.#reset();
    return discardedBytes;
  }

  #tooLarge() {
    this.#reset();
    throw new ContractError(
      "INVALID_REQUEST",
      "$",
      `protocol frame exceeds ${this.maxFrameBytes} bytes`,
    );
  }

  #append(bytes) {
    if (bytes.length > this.maxFrameBytes - this.bufferedBytes) this.#tooLarge();
    let offset = 0;
    while (offset < bytes.length) {
      if (this.tail === undefined) {
        this.tail = Buffer.allocUnsafe(Math.min(FRAME_BLOCK_BYTES, this.maxFrameBytes));
      }
      const copied = Math.min(this.tail.length - this.tailLength, bytes.length - offset);
      bytes.copy(this.tail, this.tailLength, offset, offset + copied);
      this.tailLength += copied;
      this.bufferedBytes += copied;
      offset += copied;
      if (this.tailLength === this.tail.length) {
        this.blocks.push(this.tail);
        this.tail = undefined;
        this.tailLength = 0;
      }
    }
  }

  #materialize(segment, frameBytes) {
    // Reuse an exactly-sized block when the newline completes it. This avoids
    // retaining unused slab capacity while removing a full-frame copy for the
    // common exact-block boundary.
    if (this.blocks.length === 0
      && this.tail !== undefined
      && frameBytes === this.tail.length) {
      segment.copy(this.tail, this.tailLength);
      return this.tail;
    }
    if (this.blocks.length === 1
      && this.tail === undefined
      && segment.length === 0) {
      return this.blocks[0];
    }
    const frame = Buffer.allocUnsafe(frameBytes);
    let offset = 0;
    for (const block of this.blocks) {
      block.copy(frame, offset);
      offset += block.length;
    }
    if (this.tail !== undefined && this.tailLength > 0) {
      this.tail.copy(frame, offset, 0, this.tailLength);
      offset += this.tailLength;
    }
    segment.copy(frame, offset);
    return frame;
  }

  #reset() {
    this.blocks.length = 0;
    this.tail = undefined;
    this.tailLength = 0;
    this.bufferedBytes = 0;
  }
}
