import type { AnalysisStatus } from '../learning/repository.js';
import {
  renderHumanDocument,
  type HumanBlock,
  type HumanDocument,
  type HumanRenderOptions
} from './human-renderer.js';

interface KnowledgeRecord {
  readonly id: string;
  readonly state: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly authoritative?: boolean;
}

interface Version2HealthReport {
  readonly installation?: { readonly state: string };
  readonly delivery?: { readonly state: string };
  readonly dataQuality?: { readonly state: string; readonly denominator?: { readonly state: string } };
  readonly analysis?: { readonly state: string; readonly result: string; readonly coverage: { readonly total?: number; readonly truncated?: boolean; readonly detectors: readonly unknown[] } };
  readonly repositories?: readonly { readonly repository: { readonly id: string }; readonly installation: { readonly state: string }; readonly delivery: { readonly state: string }; readonly dataQuality: { readonly state: string }; readonly analysis: { readonly state: string; readonly result: string } }[];
}

interface RuntimeConfigurationExplanation {
  readonly profile: {
    readonly id: string;
    readonly hardBlocking: boolean;
    readonly warningsEnabled: boolean;
    readonly captureEnabled: boolean;
    readonly retrievalEnabled: boolean;
    readonly degradedOutcomes: Readonly<Record<'normal' | 'caution' | 'protected', string>>;
  };
  readonly trace: Readonly<Record<'id' | 'hardBlocking' | 'warningsEnabled' | 'captureEnabled' | 'retrievalEnabled' | 'degradedOutcomes', { readonly source: string; readonly profileId?: string }>>;
}

export function renderCommandResult(
  value: unknown,
  positionals: readonly string[],
  options: HumanRenderOptions = {}
): string {
  const [command, subcommand] = positionals;
  if ((command === 'status' || command === 'status-global' || (command === 'analysis' && subcommand === 'report'))
    && (value as { schemaVersion?: number }).schemaVersion === 2) return renderVersion2Health(value as Version2HealthReport, command, subcommand, options);
  if (command === 'init') return renderInitialization(value, options);
  if (command === 'unregister') {
    const result = value as { repositoryId: string; removed: boolean };
    return renderHumanDocument({
      title: 'Repository registration',
      status: status(result.removed ? 'removed' : 'not registered', result.removed ? 'success' : 'neutral'),
      sections: [fields([['Repository', result.repositoryId]])]
    }, options);
  }
  if (command === 'experience' && subcommand === 'add') {
    return renderHumanDocument({ title: 'Experience import', status: status('complete', 'success'), sections: [fields([['Imported', countLabel((value as { imported: number }).imported, 'knowledge entry')]])] }, options);
  }
  if (command === 'validate') return renderHumanDocument({ title: 'Validation', status: status('passed', 'success'), sections: [] }, options);
  if (command === 'inspect') return renderKnowledge(value as KnowledgeRecord, true, options);
  if (command === 'lessons' || command === 'retrieve') return renderKnowledgeList(value as readonly KnowledgeRecord[], 'Knowledge', options);
  if (command === 'export') {
    const entries = (value as { knowledge: readonly KnowledgeRecord[] }).knowledge;
    return renderHumanDocument({
      title: 'Knowledge export',
      status: status('complete', 'success'),
      sections: [fields([['Exported', countLabel(entries.length, 'knowledge entry')]]), ...knowledgeSections(entries)]
    }, options);
  }
  if (command === 'list' && subcommand === 'records') return renderRecords(value, options);
  if (command === 'stats') return renderStatistics(value, options);
  if (command === 'evidence' && subcommand === 'session') return renderEvidence(value, options);
  if (command === 'status') return renderRepositoryStatus(value, options);
  if (command === 'status-global') return renderGlobalStatus(value, options);
  if (command === 'hooks' && subcommand === 'verify') return renderHookReadiness(value, options);
  if ((command === 'hooks' && subcommand === 'diagnostics') || (command === 'experience' && subcommand === 'inspect')) return renderCaptureDiagnostics(value, options);
  if (command === 'capture') return renderGeneric(`Capture ${subcommand ?? 'result'}`, value, options);
  if (command === 'analysis' && subcommand === 'status') return renderAnalysisStatus(value, options);
  if (command === 'analysis') return renderGeneric(`Analysis ${subcommand ?? 'result'}`, value, options);
  if (command === 'review' && subcommand === 'session') return renderReview(value, options);
  if (command === 'review' && subcommand === 'sessions') return renderReviewSessions(value, options);
  if (command === 'runtime' && subcommand === 'evaluate') return renderRuntimeDecision(value, options);
  if (command === 'runtime' && subcommand === 'status') return renderRuntimeStatus(value, options);
  if (command === 'runtime' && subcommand === 'config') return renderRuntimeConfiguration(value as RuntimeConfigurationExplanation, options);
  if (command === 'skill') return renderSkill(value, subcommand, options);
  if (command === 'knowledge') return renderKnowledgeOperation(value, subcommand, options);
  return renderGeneric('AEL result', value, options);
}

function renderInitialization(value: unknown, options: HumanRenderOptions): string {
  const initialized = value as { kind?: string; id?: string; databasePath?: string; repository?: { id?: string; root?: string } };
  const rows: Array<readonly [string, string]> = [];
  if (initialized.kind === 'workspace') {
    rows.push(['Scope', 'workspace'], ['Workspace', initialized.id ?? 'unknown']);
  } else if (initialized.repository !== undefined) {
    rows.push(['Scope', 'repository'], ['Repository', initialized.repository.id ?? 'unknown']);
    if (initialized.repository.root !== undefined) rows.push(['Root', initialized.repository.root]);
  } else {
    rows.push(['Scope', 'global']);
    if (initialized.databasePath !== undefined) rows.push(['Database', initialized.databasePath]);
  }
  return renderHumanDocument({ title: 'AEL initialization', status: status('ready', 'success'), sections: [fields(rows)] }, options);
}

function renderKnowledge(entry: KnowledgeRecord, includeEvidence: boolean, options: HumanRenderOptions): string {
  return renderHumanDocument({
    title: `Knowledge ${entry.id}`,
    status: status(entry.state, toneForState(entry.state)),
    sections: [
      { heading: 'Statement', blocks: [{ kind: 'text', value: entry.statement }] },
      fields([
        ['Authoritative', entry.authoritative ? 'yes' : 'no'],
        ...(includeEvidence ? [['Evidence', entry.evidenceIds.join(', ') || 'none'] as const] : [])
      ], 'Details')
    ]
  }, options);
}

function renderKnowledgeList(entries: readonly KnowledgeRecord[], title: string, options: HumanRenderOptions): string {
  return renderHumanDocument({
    title,
    status: status(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`, 'neutral'),
    sections: entries.length === 0 ? [empty('No knowledge entries found.')] : knowledgeSections(entries)
  }, options);
}

function knowledgeSections(entries: readonly KnowledgeRecord[]): HumanDocument['sections'] {
  return entries.map((entry) => ({
    heading: `${entry.id}  [${entry.state}]${entry.authoritative ? '  [authoritative]' : ''}`,
    blocks: [{ kind: 'text' as const, value: entry.statement }]
  }));
}

function renderRecords(value: unknown, options: HumanRenderOptions): string {
  const records = value as readonly { session: { id: string; source: string; startedAt: string; endedAt?: string }; events: readonly { phase: string; occurredAt: string; summary: string; outcome?: string }[] }[];
  return renderHumanDocument({
    title: 'Captured records',
    status: status(`${records.length} ${records.length === 1 ? 'session' : 'sessions'}`, 'neutral'),
    sections: records.length === 0 ? [empty('No captured records found.')] : records.map(({ session, events }) => ({
      heading: session.id,
      blocks: [
        { kind: 'fields', rows: [
          { label: 'Source', value: session.source },
          { label: 'Started', value: session.startedAt },
          { label: 'Ended', value: session.endedAt ?? 'open' }
        ] },
        ...(events.length === 0 ? [] : [{ kind: 'table' as const, columns: ['Time', 'Phase', 'Summary', 'Outcome'], rows: events.map((event) => [event.occurredAt, event.phase, event.summary, event.outcome ?? '']) }])
      ]
    }))
  }, options);
}

function renderStatistics(value: unknown, options: HumanRenderOptions): string {
  const stats = value as { sessions: number; events: number; knowledge: number; firstRecordedAt?: string; lastRecordedAt?: string; sources: Record<string, number>; phases: Record<string, number> };
  return renderHumanDocument({
    title: 'Repository statistics',
    sections: [
      fields([
        ['Sessions', String(stats.sessions)], ['Events', String(stats.events)], ['Knowledge', String(stats.knowledge)],
        ...(stats.firstRecordedAt === undefined ? [] : [['First recorded', stats.firstRecordedAt] as const]),
        ...(stats.lastRecordedAt === undefined ? [] : [['Last recorded', stats.lastRecordedAt] as const])
      ]),
      keyCountSection('Sources', stats.sources),
      keyCountSection('Phases', stats.phases)
    ]
  }, options);
}

function renderRepositoryStatus(value: unknown, options: HumanRenderOptions): string {
  const report = value as { status: string; repository: { id: string; root?: string }; selectedSources: readonly string[]; cli?: { entrypoint: string; available: boolean }; database?: { path: string; available: boolean }; sources: readonly { source: string; status: string; code?: string }[] };
  return renderHumanDocument(repositoryStatusDocument(report, `Repository ${report.repository.id}`), options);
}

function repositoryStatusDocument(report: { status: string; repository: { id: string; root?: string }; selectedSources: readonly string[]; cli?: { entrypoint: string; available: boolean }; database?: { path: string; available: boolean }; sources: readonly { source: string; status: string; code?: string }[] }, title: string): HumanDocument {
  return {
    title,
    status: status(report.status, toneForState(report.status)),
    sections: [
      fields([
        ['Required hooks', report.selectedSources.join(', ') || 'none'],
        ...(report.repository.root === undefined ? [] : [['Root', report.repository.root] as const]),
        ...(report.cli === undefined ? [] : [['CLI', `${report.cli.available ? 'available' : 'unavailable'} (${report.cli.entrypoint})`] as const]),
        ...(report.database === undefined ? [] : [['Database', `${report.database.available ? 'available' : 'unavailable'} (${report.database.path})`] as const])
      ], 'Installation'),
      report.sources.length === 0 ? empty('No hook sources are configured.', 'Hooks') : {
        heading: 'Hooks',
        blocks: [{ kind: 'table', columns: ['Source', 'Status', 'Code'], rows: report.sources.map((source) => [source.source, source.status, source.code ?? '']) }]
      }
    ]
  };
}

function renderGlobalStatus(value: unknown, options: HumanRenderOptions): string {
  const report = value as { status: string; database: { path: string; available: boolean }; cli: { entrypoint: string; available: boolean }; repositories: readonly { status: string; repository: { id: string; root?: string }; selectedSources: readonly string[]; sources: readonly { source: string; status: string; code?: string }[] }[] };
  return renderHumanDocument({
    title: 'AEL status',
    status: status(report.status, toneForState(report.status)),
    sections: [
      fields([['CLI', `${report.cli.available ? 'available' : 'unavailable'} (${report.cli.entrypoint})`], ['Database', `${report.database.available ? 'available' : 'unavailable'} (${report.database.path})`]], 'Installation'),
      report.repositories.length === 0 ? empty('No registered repositories.', 'Repositories') : {
        heading: 'Repositories',
        blocks: [{ kind: 'table', columns: ['ID', 'Status', 'Hooks'], rows: report.repositories.map((entry) => [entry.repository.id, entry.status, entry.selectedSources.join(', ') || 'none']) }]
      }
    ]
  }, options);
}

function renderVersion2Health(report: Version2HealthReport, command: string | undefined, subcommand: string | undefined, options: HumanRenderOptions): string {
  if (command === 'analysis' && subcommand === 'report') {
    const analysis = report.analysis!;
    return renderHumanDocument({ title: 'Analysis report', status: status(analysis.state, toneForState(analysis.state)), sections: [fields([['Result', analysis.result], ['Coverage', `${analysis.coverage.total ?? analysis.coverage.detectors.length}${analysis.coverage.truncated ? ' (truncated)' : ''}`]])] }, options);
  }
  if (command === 'status-global') {
    return renderHumanDocument({
      title: 'AEL status',
      status: status(report.installation?.state ?? 'unknown', toneForState(report.installation?.state ?? 'unknown')),
      sections: [(report.repositories ?? []).length === 0 ? empty('No registered repositories.', 'Repositories') : {
        heading: 'Repositories',
        blocks: [{ kind: 'table', columns: ['ID', 'Installation', 'Delivery', 'Data quality', 'Analysis'], rows: (report.repositories ?? []).map(({ repository, installation, delivery, dataQuality, analysis }) => [repository.id, installation.state, delivery.state, dataQuality.state, `${analysis.state}/${analysis.result}`]) }]
      }]
    }, options);
  }
  return renderHumanDocument({
    title: 'Repository health',
    status: status(report.installation?.state ?? 'unknown', toneForState(report.installation?.state ?? 'unknown')),
    sections: [fields([
      ['Installation', report.installation?.state ?? 'unknown'],
      ['Delivery', report.delivery?.state ?? 'unknown'],
      ['Data quality', report.dataQuality?.state ?? 'unknown'],
      ['Analysis', report.analysis?.state ?? 'unknown'],
      ['Analysis result', report.analysis?.result ?? 'unknown'],
      ['Coverage', report.analysis === undefined ? 'unknown' : `${report.analysis.coverage.total ?? report.analysis.coverage.detectors.length}${report.analysis.coverage.truncated ? ' (truncated)' : ''}`]
    ])]
  }, options);
}

function renderCaptureDiagnostics(value: unknown, options: HumanRenderOptions): string {
  const report = value as { scope: { kind: string; id: string }; counts: Record<string, number> };
  return renderHumanDocument({ title: 'Capture diagnostics', sections: [fields([['Scope', `${report.scope.kind} ${report.scope.id}`]]), keyCountSection('Counts', report.counts)] }, options);
}

function renderAnalysisStatus(value: unknown, options: HumanRenderOptions): string {
  const report = value as AnalysisStatus & { readonly workerConfig: { readonly maxProcesses: number; readonly idleTimeoutMs: number }; readonly activeChildren: number };
  return renderHumanDocument({
    title: 'Analysis worker',
    sections: [
      fields([
        ['Max processes', String(report.workerConfig.maxProcesses)], ['Idle timeout', `${report.workerConfig.idleTimeoutMs} ms`],
        ['Coordinator', report.coordinatorLease === null ? 'none' : `active, attempt ${report.coordinatorLease.attempt}, expires ${report.coordinatorLease.leaseExpiresAt}`],
        ['Active children', String(report.activeChildren)], ['Oldest outstanding', report.oldestOutstandingAgeMs == null ? 'none' : `${report.oldestOutstandingAgeMs} ms`],
        ['Next retry', report.nextRetryAt ?? 'none'], ['Attempts', String(report.totalAttempts)], ['Scheduled retries', String(report.totalRetries)],
        ['Events loaded', String(report.eventsLoaded)], ['Unique acknowledged', String(report.uniqueAcknowledgedEvents)], ['Reread ratio', String(report.rereadRatio)]
      ]),
      keyCountSection('Queue', report.jobs),
      keyCountSection('Failure attempts', report.failureCounts),
      keyCountSection('Worker diagnostics', report.diagnostics)
    ]
  }, options);
}

function renderEvidence(value: unknown, options: HumanRenderOptions): string {
  const stored = value as { version: number; report: { sessionId: string; lifecycle: { state: string }; operations: readonly unknown[]; metrics: { tokenUsage?: unknown } } };
  return renderHumanDocument({ title: `Session ${stored.report.sessionId}`, status: status(stored.report.lifecycle.state, toneForState(stored.report.lifecycle.state)), sections: [fields([['Evidence version', String(stored.version)], ['Operations', String(stored.report.operations.length)], ['Token usage', stored.report.metrics.tokenUsage === undefined ? 'unavailable' : 'source-provided']])] }, options);
}

function renderHookReadiness(value: unknown, options: HumanRenderOptions): string {
  const result = value as { status: string; sources: readonly { source: string }[]; code?: string };
  return renderHumanDocument({ title: 'Hook readiness', status: status(result.status, toneForState(result.status)), sections: [fields([['Sources', result.sources.map(({ source }) => source).join(', ') || 'none'], ...(result.code === undefined ? [] : [['Code', result.code] as const])])] }, options);
}

function renderReview(value: unknown, options: HumanRenderOptions): string {
  const result = value as { findings: readonly unknown[]; candidates: readonly unknown[]; proposals: readonly unknown[]; skippedReviewerIds: readonly string[]; ingestionCoverage?: { skippedTechnicalRecords: number; unsupportedRecords: number; truncatedTextFields: number; omittedStructuredOutputs: number } };
  return renderHumanDocument({ title: 'Session review', status: status('complete', 'success'), sections: [fields([['Finding groups', String(result.findings.length)], ['Candidates', String(result.candidates.length)], ['Proposals', String(result.proposals.length)], ['Skipped reviewers', result.skippedReviewerIds.join(', ') || 'none']]), ...(result.ingestionCoverage === undefined ? [] : [fields([['Technical skipped', String(result.ingestionCoverage.skippedTechnicalRecords)], ['Unsupported', String(result.ingestionCoverage.unsupportedRecords)], ['Text truncated', String(result.ingestionCoverage.truncatedTextFields)], ['Structured omitted', String(result.ingestionCoverage.omittedStructuredOutputs)]], 'Ingestion')])] }, options);
}

function renderReviewSessions(value: unknown, options: HumanRenderOptions): string {
  const sessions = value as readonly { id: string; source?: string; updatedAt?: string }[];
  return renderHumanDocument({ title: 'Review sessions', status: status(`${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`, 'neutral'), sections: sessions.length === 0 ? [empty('No sessions found.')] : [{ blocks: [{ kind: 'table', columns: ['ID', 'Source', 'Updated'], rows: sessions.map((session) => [session.id, session.source ?? '', session.updatedAt ?? '']) }] }] }, options);
}

function renderRuntimeDecision(value: unknown, options: HumanRenderOptions): string {
  const decision = value as { outcome: string; explanations: readonly unknown[]; status: { health: string; fallbackSource: string } };
  return renderHumanDocument({ title: 'Runtime decision', status: status(decision.outcome, toneForState(decision.outcome)), sections: [fields([['Matching rules', String(decision.explanations.length)], ['Runtime health', decision.status.health], ['Fallback', decision.status.fallbackSource]])] }, options);
}

function renderRuntimeStatus(value: unknown, options: HumanRenderOptions): string {
  const report = value as { health: string; profileId: string; fallbackSource: string; circuitState: string };
  return renderHumanDocument({ title: 'Runtime status', status: status(report.health, toneForState(report.health)), sections: [fields([['Profile', report.profileId], ['Fallback', report.fallbackSource], ['Circuit', report.circuitState]])] }, options);
}

function renderRuntimeConfiguration(value: RuntimeConfigurationExplanation, options: HumanRenderOptions): string {
  const profile = value.profile;
  const rows: Array<readonly [string, string]> = [
    ['Profile', profile.id], ['Hard blocking', String(profile.hardBlocking)], ['Warnings', String(profile.warningsEnabled)],
    ['Capture', String(profile.captureEnabled)], ['Retrieval', String(profile.retrievalEnabled)],
    ['Degraded outcomes', `normal=${profile.degradedOutcomes.normal}, caution=${profile.degradedOutcomes.caution}, protected=${profile.degradedOutcomes.protected}`]
  ];
  const traceRows = Object.entries(value.trace).map(([field, trace]) => [field, `${trace.source}${trace.profileId === undefined ? '' : `:${trace.profileId}`}`] as const);
  return renderHumanDocument({ title: 'Runtime configuration', status: status(profile.id, 'neutral'), sections: [fields(rows, 'Profile'), fields(traceRows, 'Sources')] }, options);
}

function renderSkill(value: unknown, subcommand: string | undefined, options: HumanRenderOptions): string {
  const result = value as { status?: string; destination?: string; manifest?: { files?: readonly unknown[] } };
  return renderHumanDocument({ title: `AEL skill ${subcommand ?? 'operation'}`, status: status(result.status ?? 'complete', toneForState(result.status ?? 'complete')), sections: [fields([...(result.destination === undefined ? [] : [['Destination', result.destination] as const]), ...(result.manifest?.files === undefined ? [] : [['Files', String(result.manifest.files.length)] as const])])] }, options);
}

function renderKnowledgeOperation(value: unknown, subcommand: string | undefined, options: HumanRenderOptions): string {
  const result = value as { identity?: string; entries?: number; trustedRefActive?: boolean; rules?: number; trustedCommit?: string };
  const rows: Array<readonly [string, string]> = [];
  if (result.identity !== undefined) rows.push(['Identity', result.identity]);
  if (result.entries !== undefined) rows.push(['Entries', String(result.entries)]);
  if (result.trustedRefActive !== undefined) rows.push(['Trusted ref', result.trustedRefActive ? 'active' : 'inactive']);
  if (result.rules !== undefined) rows.push(['Rules', String(result.rules)]);
  if (result.trustedCommit !== undefined) rows.push(['Trusted commit', result.trustedCommit]);
  return renderHumanDocument({ title: `Knowledge ${subcommand ?? 'operation'}`, status: status('complete', 'success'), sections: rows.length === 0 ? [empty('No additional details.')] : [fields(rows)] }, options);
}

function renderGeneric(title: string, value: unknown, options: HumanRenderOptions): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return renderHumanDocument({ title, sections: [{ blocks: [{ kind: 'text', value: displayValue(value) }] }] }, options);
  }
  const rows = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [humanize(key), displayValue(entry)] as const);
  return renderHumanDocument({ title, sections: rows.length === 0 ? [empty('No details available.')] : [fields(rows)] }, options);
}

function keyCountSection(heading: string, values: Readonly<Record<string, number>>): HumanDocument['sections'][number] {
  const entries = Object.entries(values);
  return entries.length === 0 ? empty('None.', heading) : { heading, blocks: [{ kind: 'table', columns: ['Name', 'Count'], rows: entries.map(([key, count]) => [key, String(count)]) }] };
}

function fields(rows: readonly (readonly [string, string])[], heading?: string): HumanDocument['sections'][number] {
  return { ...(heading === undefined ? {} : { heading }), blocks: [{ kind: 'fields', rows: rows.map(([label, value]) => ({ label, value })) }] };
}

function empty(value: string, heading?: string): HumanDocument['sections'][number] {
  return { ...(heading === undefined ? {} : { heading }), blocks: [{ kind: 'empty', value }] };
}

function status(text: string, tone: NonNullable<HumanDocument['status']>['tone']): NonNullable<HumanDocument['status']> {
  return { text, tone };
}

function toneForState(state: string): NonNullable<HumanDocument['status']>['tone'] {
  const normalized = state.toLowerCase();
  if (['ready', 'healthy', 'passed', 'complete', 'completed', 'current', 'valid', 'installed', 'updated', 'removed', 'allow', 'verified'].includes(normalized)) return 'success';
  if (['degraded', 'warning', 'warn', 'backlogged', 'code-changed', 'unverified'].includes(normalized)) return 'warning';
  if (['failed', 'failure', 'not-ready', 'invalid', 'block', 'quarantined'].includes(normalized)) return 'failure';
  return 'neutral';
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function humanize(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))) return value.map(String).join(', ') || 'none';
  return JSON.stringify(value);
}
