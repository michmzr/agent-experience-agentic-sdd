import type { CaptureDisposition } from '../capture/spool.js';
import type { AgentSource } from '../domain/types.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

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

export function detectorEvaluation(databasePath: string, repositoryId: string, analysisState: string) {
  if (!existsSync(databasePath)) return Object.freeze({ state: 'unavailable' as const, detectors: Object.freeze([
    Object.freeze({ detector: 'repairs' as const, status: 'unsupported' as const }),
    Object.freeze({ detector: 'conventions' as const, status: 'unsupported' as const }),
    Object.freeze({ detector: 'typed' as const, status: 'unsupported' as const })
  ]) });
  const pending = analysisState === 'not-run' ? 'not-run' as const
    : analysisState === 'failed' || analysisState === 'quarantined' ? 'failed' as const
      : analysisState === 'completed' ? 'unsupported' as const : 'incomplete' as const;
  let repairStatus: 'not-run' | 'failed' | 'incomplete' | 'unsupported' | 'insufficient-evidence' = pending;
  let evidenceAvailable = true;
  if (analysisState === 'completed') {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const outcomes = database.prepare(`SELECT
        COALESCE(SUM(CASE WHEN COALESCE(c.phase, r.phase) = 'post-result' AND COALESCE(c.capture_outcome, r.capture_outcome) = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_results,
        COALESCE(SUM(CASE WHEN COALESCE(c.phase, r.phase) = 'post-result' AND COALESCE(c.capture_outcome, r.capture_outcome) IN ('succeeded', 'failed') THEN 1 ELSE 0 END), 0) AS qualified_results
        FROM logical_evidence l JOIN sessions s ON s.id = l.session_id
        LEFT JOIN capture_events c ON c.event_id = l.event_id
        LEFT JOIN capture_run_events r ON r.event_id = l.event_id
        WHERE s.repository_id = ?`).get(repositoryId) as { unknown_results: number; qualified_results: number };
      const uncovered = database.prepare(`SELECT COUNT(*) AS count FROM logical_evidence l JOIN sessions s ON s.id = l.session_id
        WHERE s.repository_id = ? AND NOT EXISTS (SELECT 1 FROM operational_analysis_streams a
          WHERE a.repository_id = s.repository_id AND a.session_id = l.session_id AND a.processed_high_water >= l.ordinal)`)
        .get(repositoryId) as { count: number };
      if (uncovered.count > 0) repairStatus = 'incomplete';
      else if (outcomes.unknown_results > 0 && outcomes.qualified_results === 0) repairStatus = 'insufficient-evidence';
    } catch { repairStatus = 'unsupported'; evidenceAvailable = false; }
    finally { database?.close(); }
  }
  return Object.freeze({ state: evidenceAvailable ? 'available' as const : 'unavailable' as const, detectors: Object.freeze([
    Object.freeze({ detector: 'repairs' as const, status: repairStatus }),
    Object.freeze({ detector: 'conventions' as const, status: pending }),
    Object.freeze({ detector: 'typed' as const, status: pending })
  ]) });
}
