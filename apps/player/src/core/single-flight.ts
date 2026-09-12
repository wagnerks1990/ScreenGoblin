/** Drops an overlapping invocation while one asynchronous operation is active. */
export class SingleFlight {
  private active = false;

  async run(task: () => Promise<void>): Promise<boolean> {
    if (this.active) return false;
    this.active = true;
    try {
      await task();
      return true;
    } finally {
      this.active = false;
    }
  }
}
