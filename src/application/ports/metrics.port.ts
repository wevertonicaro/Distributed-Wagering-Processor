export interface ProcessingMetrics {
  transaction(status: string, replay: boolean, seconds: number): void;
  lockWait(seconds: number): void;
}

export const noopMetrics: ProcessingMetrics = { transaction() {}, lockWait() {} };