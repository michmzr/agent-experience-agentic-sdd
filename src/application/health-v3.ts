import type { CaptureDisposition } from '../capture/spool.js';

export interface ScopedCaptureReceipt {
  readonly repositoryId?: string;
  readonly source: 'codex' | 'cursor';
  readonly eventClass?: 'session-start' | 'session-end' | 'technical';
  readonly operationKey?: string;
  readonly disposition: CaptureDisposition;
}

export function scopedReceiptHealth(
  receipts: readonly ScopedCaptureReceipt[],
  repositoryId: string,
  accounting: 'available' | 'unavailable'
) {
  const scoped = receipts.filter(receipt => receipt.repositoryId === repositoryId);
  const operationKeys = new Set(scoped
    .filter(receipt => receipt.disposition === 'accepted' || receipt.disposition === 'duplicate')
    .map(receipt => receipt.operationKey)
    .filter((key): key is string => key !== undefined));
  return Object.freeze({
    accounting,
    windowBounded: true as const,
    deliveries: scoped.length,
    uniqueOperations: operationKeys.size,
    sourceDenominator: Object.freeze({ state: 'unavailable' as const })
  });
}
