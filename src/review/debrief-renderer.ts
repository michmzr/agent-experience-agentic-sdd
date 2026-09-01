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

// Unicode East_Asian_Width=W/F intervals, with terminal-wide CJK compatibility blocks.
// Keep sorted so the binary search remains deterministic and reviewable.
const wideIntervals: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf], [0xa960, 0xa97c],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff01, 0xff60], [0xffe0, 0xffe6],
  [0x1b000, 0x1b2ff], [0x1f1e6, 0x1f1ff], [0x1f200, 0x1f251], [0x1f3fb, 0x1f3ff], [0x20000, 0x3fffd]
];

function graphemeWidth(value: string): number {
  if (/^[\p{Mark}\p{Variation_Selector}\u200d]*$/u.test(value)) return 0;
  if (/\p{Emoji_Presentation}|\u20e3/u.test(value)) return 2;
  if (/\uFE0F/u.test(value) && /\p{Extended_Pictographic}/u.test(value)) return 2;
  return [...value].some((character) => isWideCodePoint(character.codePointAt(0)!)) ? 2 : 1;
}

function isWideCodePoint(value: number): boolean {
  let lower = 0;
  let upper = wideIntervals.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const [start, end] = wideIntervals[middle]!;
    if (value < start) upper = middle - 1;
    else if (value > end) lower = middle + 1;
    else return true;
  }
  return false;
}
