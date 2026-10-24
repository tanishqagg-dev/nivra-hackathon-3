/** Scene time follows the source; performance metrics keep using wall time. */
export class SourceClock {
  private mode: 'camera' | 'clip' = 'camera'
  private epoch = 0
  private wallOrigin = 0
  private lastIssued = Number.NEGATIVE_INFINITY

  begin(mode: 'camera' | 'clip', wallMs: number): void {
    this.mode = mode
    this.epoch = Math.max(wallMs, this.lastIssued + 1)
    this.wallOrigin = wallMs
  }

  read(wallMs: number, mediaSeconds = 0): number {
    return this.epoch + (this.mode === 'clip' ? mediaSeconds * 1000 : wallMs - this.wallOrigin)
  }

  frame(wallMs: number, mediaSeconds = 0): number {
    // A cancelled frame can be retried at the same source position. MediaPipe
    // still requires a strictly increasing transport timestamp for that retry.
    const timestamp = Math.max(this.read(wallMs, mediaSeconds), this.lastIssued + 0.001)
    this.lastIssued = Math.max(this.lastIssued, timestamp)
    return timestamp
  }
}
