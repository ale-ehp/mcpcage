const LF = 0x0a;
const CR = 0x0d;
const NOTHING = Buffer.alloc(0);

/**
 * The longest line mcpcage reads from a server, in bytes. Large tool results such as file contents
 * fit; nothing legitimate needs more.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Splits a byte stream into lines the way `readline` does with `crlfDelay: Infinity`: "\n", "\r\n"
 * and a lone "\r" end a line, a "\r\n" split across two chunks is one ending, and a last line without
 * an ending still counts. Unlike readline it never holds more than `maxBytes` of a line: once a line
 * is longer, the rest of it is counted and thrown away as it streams in, so a server that writes
 * gigabytes without a newline cannot exhaust mcpcage's memory. `oversize` gets the full size of such
 * a line when it ends, and its first `maxBytes` bytes, for a caller that shows the line cut.
 */
export class LineSplitter {
  /** The start of the current line, when it began in an earlier chunk. */
  private held = NOTHING;
  /** Bytes of the current line so far, the ones already thrown away included. */
  private bytes = 0;
  /** The last chunk ended with "\r": a "\n" at the start of the next one belongs to that ending. */
  private afterCR = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOversize: (bytes: number, head: Buffer) => void,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    if (this.afterCR && chunk.length > 0) {
      this.afterCR = false;
      if (chunk[0] === LF) start = 1;
    }
    // Where the next "\n" and "\r" are: -2 not looked up yet, -1 none left in this chunk. Each search
    // starts where the last one stopped, so even a chunk of nothing but "\r" is read once.
    let lf = -2;
    let cr = -2;
    while (start < chunk.length) {
      if (lf !== -1 && lf < start) lf = chunk.indexOf(LF, start);
      if (cr !== -1 && cr < start) cr = chunk.indexOf(CR, start);
      const end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      if (end === -1) break;
      if (this.bytes === 0 && end - start <= this.maxBytes) this.onLine(chunk.toString("utf8", start, end));
      else {
        this.add(chunk, start, end);
        this.finish();
      }
      start = end + 1;
      if (chunk[end] === CR) {
        if (start === chunk.length) this.afterCR = true;
        else if (chunk[start] === LF) start++;
      }
    }
    this.add(chunk, start, chunk.length);
  }

  /** The stream is over: what is left is the last line. */
  end(): void {
    if (this.bytes > 0) this.finish();
  }

  private add(chunk: Buffer, from: number, to: number): void {
    if (to <= from) return;
    // Only the first maxBytes are kept; past them a line is only counted.
    const kept = Math.min(this.bytes, this.maxBytes);
    this.bytes += to - from;
    const end = Math.min(to, from + this.maxBytes - kept);
    if (end <= from) return;
    const needed = kept + end - from;
    if (needed > this.held.length) {
      const grown = Buffer.allocUnsafe(Math.min(this.maxBytes, Math.max(needed, this.held.length * 2, 64 * 1024)));
      this.held.copy(grown, 0, 0, kept);
      this.held = grown;
    }
    chunk.copy(this.held, kept, from, end);
  }

  private finish(): void {
    const { bytes, held } = this;
    this.bytes = 0;
    this.held = NOTHING;
    if (bytes > this.maxBytes) this.onOversize(bytes, held.subarray(0, this.maxBytes));
    else this.onLine(held.toString("utf8", 0, bytes));
  }
}
