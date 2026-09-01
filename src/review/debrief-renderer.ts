import type { DebriefEvidence, DebriefInsight, DebriefTimelineEntry, SessionDebrief } from './debrief-model.js';
import type { DebriefState } from './debrief-state.js';

const ansi = {
  reset: '\u001b[0m', dim: '\u001b[2m', cyan: '\u001b[36m', green: '\u001b[32m',
  yellow: '\u001b[33m', red: '\u001b[31m', bold: '\u001b[1m'
} as const;
const ansiPattern = /\u001b\[(?:0|1|2|31|32|33|36)m/g;

type Role = keyof typeof ansi;
interface Row { readonly text: string; readonly role?: Role; }

export function renderSessionDebrief(model: SessionDebrief, state: DebriefState): string {
  const normal = state.width >= 80 && state.height >= 24;
  const insight = state.selectedInsightIndex === null ? undefined : model.insights[state.selectedInsightIndex];
  const rows: Row[] = normal ? [{ text: `+${'-'.repeat(state.width - 2)}+`, role: 'cyan' }] : [];
  rows.push(
    { text: 'SESSION DEBRIEF', role: 'cyan' },
    { text: metadata(model, normal), role: 'dim' },
    { text: model.headline }
  );

  if (!insight) rows.push({ text: 'No corroborated insights' });
  else if (state.view === 'detail') rows.push(...detailRows(insight, state.evidenceExpanded));
  else rows.push(...overviewRows(insight, model.insights.length, model.counts, model.insights.indexOf(insight)));

  const help = normal ? 'Up/Down select · Enter details · d evidence · Esc back · q quit' : 'Enter details · d evidence · Esc back · q quit';
  return fitFrame(rows, { text: help, role: 'cyan' }, state);
}

export function stripAnsi(value: string): string { return value.replace(ansiPattern, ''); }

export function visibleWidth(value: string): number { return graphemes(stripAnsi(value)).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0); }

function overviewRows(insight: DebriefInsight, count: number, counts: SessionDebrief['counts'], selectedIndex: number): Row[] {
  const rows: Row[] = [
    { text: `Insight ${selectedIndex + 1}/${count} · ${insight.category}`, role: 'cyan' },
    { text: `${insight.title} [${insight.severity}]`, role: severityRole(insight.severity) },
    { text: 'Recommendation', role: 'cyan' },
    { text: insight.recommendation }
  ];
  if (insight.timeline.length === 0) rows.push({ text: 'No event timeline is available' });
  else {
    rows.push({ text: 'Timeline', role: 'cyan' });
    rows.push(...insight.timeline.slice(0, 5).map(timelineRow));
  }
  rows.push({ text: `Strengths ${counts.strengths} · Improvements ${counts.improvements} · Conflicts ${counts.conflicts} · Diagnostics ${counts.diagnostics}`, role: 'cyan' });
  return rows;
}

function detailRows(insight: DebriefInsight, expanded: boolean): Row[] {
  const rows: Row[] = [
    { text: `Detail · ${insight.category} · ${insight.severity}`, role: 'cyan' },
    { text: insight.title, role: severityRole(insight.severity) },
    { text: 'Recommendation', role: 'cyan' },
    { text: insight.recommendation },
    { text: `${insight.evidence.length} linked events`, role: 'cyan' }
  ];
  if (expanded) rows.push(...insight.evidence.map(evidenceRow));
  else if (insight.evidence.length > 0) rows.push({ text: 'Press d to expand linked evidence.', role: 'dim' });
  else rows.push({ text: 'No linked event evidence is available.' });
  if (insight.timeline.length === 0) rows.push({ text: 'No event timeline is available' });
  return rows;
}

function timelineRow(entry: DebriefTimelineEntry): Row {
  if (entry.kind === 'session-start') return { text: `${shortTime(entry.occurredAt)} session started`, role: 'dim' };
  if (entry.kind === 'session-end') return { text: `${shortTime(entry.occurredAt)} session ended`, role: 'dim' };
  return evidenceRow(entry.evidence!);
}

function evidenceRow(evidence: DebriefEvidence): Row { return { text: `${shortTime(evidence.occurredAt)} ${evidence.summary}`, role: outcomeRole(evidence.outcome) }; }
function metadata(model: SessionDebrief, normal: boolean): string {
  const duration = `${Math.floor(model.durationMs / 60_000)}m`;
  return normal
    ? `Source ${model.source} · ${model.sessionPseudonym} · ${duration} · ${model.actionCount} actions`
    : `${model.source} · ${duration} · ${model.actionCount} actions`;
}
function shortTime(value: string): string { return value.slice(11, 16) || value; }
function fitFrame(rows: readonly Row[], help: Row, state: DebriefState): string {
  const body = rows.slice(0, Math.max(0, state.height - 1));
  return [...body, help].map((row) => style(fitText(row.text, state.width), row.role, state.color)).join('\n');
}

function style(value: string, role: Role | undefined, color: boolean): string {
  if (!color || !role) return value;
  const prefix = role === 'cyan' ? `${ansi.bold}${ansi.cyan}` : ansi[role];
  return `${prefix}${value}${ansi.reset}`;
}
function severityRole(value: DebriefInsight['severity']): Role | undefined { return value === 'high' ? 'red' : value === 'medium' ? 'yellow' : undefined; }
function outcomeRole(value: DebriefEvidence['outcome']): Role { return value === 'failed' ? 'red' : value === 'passed' ? 'green' : 'yellow'; }
function fitText(value: string, width: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const parts = graphemes(clean);
  if (parts.reduce((total, part) => total + graphemeWidth(part), 0) <= width) return clean;
  if (width === 1) return '…';
  const budget = width - 1;
  let used = 0;
  const fitted: string[] = [];
  for (const part of parts) {
    const partWidth = graphemeWidth(part);
    if (used + partWidth > budget) break;
    fitted.push(part);
    used += partWidth;
  }
  return `${fitted.join('')}…`;
}
function graphemes(value: string): string[] {
  const Segmenter = Intl.Segmenter;
  return typeof Segmenter === 'function' ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(({ segment }) => segment) : Array.from(value);
}

function graphemeWidth(value: string): number {
  if (/^[\p{Mark}\p{Variation_Selector}\u200d]*$/u.test(value)) return 0;
  if (/\p{Extended_Pictographic}|[\u{1f1e6}-\u{1f1ff}]|\u20e3/u.test(value)) return 2;
  return [...value].some(isWideCodePoint) ? 2 : 1;
}

function isWideCodePoint(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
