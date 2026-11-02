import { log } from '../observability/logger';

export class PollingWorker {
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private wake: () => void = () => {};

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly idleMs: number,
  ) {}

  start(): void {
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let worked = 0;
      try {
        worked = await this.tick();
      } catch (error) {
        log('error', `${this.name} tick failed`, { error: error instanceof Error ? error.message : String(error) });
      }
      if (worked === 0 && this.running) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.idleMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}