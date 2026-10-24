export class FrameGate {
  private busy = false

  tryAcquire(): boolean {
    if (this.busy) return false
    this.busy = true
    return true
  }

  release(): void {
    this.busy = false
  }

  get isBusy(): boolean {
    return this.busy
  }
}

