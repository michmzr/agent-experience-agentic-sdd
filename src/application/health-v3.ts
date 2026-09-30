import type { CaptureDisposition } from '../capture/spool.js';
import type { AgentSource } from '../domain/types.js';

export interface ScopedCaptureReceipt {
  readonly repositoryId?: string;
  readonly source?: AgentSource;
  readonly eventClass?: 'session-start' | 'session-end' | 'technical';
  readonly operationKey?: string;
  readonly disposition: CaptureDisposition;
}

export function scopedReceiptHealth(
  receipts: readonly ScopedCaptureReceipt[],
  repositoryId: string,
  accounting: 'available' | 'unavailable',
  retention?: { readonly firstSequence: number; readonly lastSequence: number; readonly capacity: number }
) {
  const scoped = receipts.filter(receipt => receipt.repositoryId === repositoryId);
  const firstOwner = new Map<string, string>();
  for (const receipt of receipts) {
    if (receipt.operationKey !== undefined && receipt.repositoryId !== undefined && !firstOwner.has(receipt.operationKey)) {
      firstOwner.set(receipt.operationKey, receipt.repositoryId);
    }
  }
  const operationKeys = new Set(scoped
    .filter(receipt => (receipt.disposition === 'accepted' || receipt.disposition === 'duplicate')
      && receipt.operationKey !== undefined && firstOwner.get(receipt.operationKey) === repositoryId)
    .map(receipt => receipt.operationKey)
    .filter((key): key is string => key !== undefined));
  return Object.freeze({
    accounting,
    windowBounded: true as const,
    deliveries: scoped.length,
    uniqueOperations: operationKeys.size,
    retainedOperations: operationKeys.size,
    bySource: Object.freeze({ codex: scoped.filter(receipt => receipt.source === 'codex').length,
      'claude-code': scoped.filter(receipt => receipt.source === 'claude-code').length,
      cursor: scoped.filter(receipt => receipt.source === 'cursor').length }),
    byEventClass: Object.freeze({
      'session-start': scoped.filter(receipt => receipt.eventClass === 'session-start').length,
      'session-end': scoped.filter(receipt => receipt.eventClass === 'session-end').length,
      technical: scoped.filter(receipt => receipt.eventClass === 'technical').length
    }),
    ...(retention === undefined ? {} : { retention }),
    sourceDenominator: Object.freeze({ state: 'unavailable' as const })
  });
}
