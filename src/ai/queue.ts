import { ViewerError } from '../core/errors.js';

export class AiExecutionQueue {
  private active = 0; private waiting = 0;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 1 && this.waiting >= 4) throw new ViewerError('AI_QUEUE_FULL', 'The AI explanation queue is full.', { retryable: true });
    if (this.active >= 1) this.waiting++;
    return (async () => {
      while (this.active >= 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (this.waiting > 0) this.waiting--; this.active++;
      try { return await operation(); }
      finally { this.active--; }
    })();
  }
}
