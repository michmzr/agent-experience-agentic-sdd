export interface HumanRenderOptions {
  readonly color?: boolean;
  readonly width?: number;
}

export type HumanBlock =
  | { readonly kind: 'fields'; readonly rows: readonly { readonly label: string; readonly value: string }[] }
  | { readonly kind: 'table'; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'empty'; readonly value: string };

export interface HumanDocument {
  readonly title: string;
  readonly status?: { readonly tone: 'success' | 'warning' | 'failure' | 'neutral'; readonly text: string };
  readonly sections: readonly { readonly heading?: string; readonly blocks: readonly HumanBlock[] }[];
}

const ANSI = Object.freeze({
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m'
});

export function renderHumanDocument(document: HumanDocument, options: HumanRenderOptions = {}): string {
  const title = style(safeValue(document.title), ANSI.bold, options);
  const status = document.status === undefined ? '' : `  ${style(`[${safeValue(document.status.text)}]`, toneColor(document.status.tone), options)}`;
  const sections = document.sections.map((section) => renderSection(section, options)).filter((section) => section.length > 0);
  return [`${title}${status}`, ...sections].join('\n\n');
}

export function renderHumanError(
  diagnostic: { readonly code: string; readonly message: string },
  nextStep?: string,
  options: HumanRenderOptions = {}
): string {
  return renderHumanDocument({
    title: 'Error',
    status: options.color ? { tone: 'failure', text: 'failed' } : undefined,
    sections: [{
      blocks: [{
        kind: 'fields',
        rows: [
          { label: 'Message', value: diagnostic.message },
          { label: 'Code', value: diagnostic.code },
          ...(nextStep === undefined ? [] : [{ label: 'Next step', value: nextStep }])
        ]
      }]
    }]
  }, options);
}

function renderSection(section: HumanDocument['sections'][number], options: HumanRenderOptions): string {
  const heading = section.heading === undefined ? [] : [style(safeValue(section.heading), ANSI.bold, options)];
  const blocks = section.blocks.map((block) => renderBlock(block, options)).filter((block) => block.length > 0);
  return [...heading, ...blocks].join('\n');
}

function renderBlock(block: HumanBlock, options: HumanRenderOptions): string {
  if (block.kind === 'text' || block.kind === 'empty') return safeValue(block.value);
  if (block.kind === 'fields') return renderFields(block.rows, options);
  return renderTable(block.columns, block.rows, options);
}

function renderFields(rows: readonly { readonly label: string; readonly value: string }[], options: HumanRenderOptions): string {
  const width = rows.reduce((longest, row) => Math.max(longest, safeValue(row.label).length), 0);
  return rows.map((row) => {
    const label = safeValue(row.label).padEnd(width);
    return `${style(label, ANSI.dim, options)}  ${safeValue(row.value)}`;
  }).join('\n');
}

function renderTable(columns: readonly string[], rows: readonly (readonly string[])[], options: HumanRenderOptions): string {
  const safeColumns = columns.map(safeValue);
  const safeRows = rows.map((row) => row.map((value) => safeValue(value)));
  const widths = safeColumns.map((column, index) => Math.max(column.length, ...safeRows.map((row) => row[index]?.length ?? 0)));
  const requiredWidth = widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * 2;
  if (requiredWidth > (options.width ?? 80)) {
    return safeRows.map((row) => renderFields(safeColumns.map((label, index) => ({ label, value: row[index] ?? '' })), options)).join('\n\n');
  }
  const line = (values: readonly string[]): string => values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join('  ').trimEnd();
  return [
    style(line(safeColumns), ANSI.dim, options),
    line(widths.map((width) => '-'.repeat(width))),
    ...safeRows.map(line)
  ].join('\n');
}

function safeValue(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function style(value: string, code: string, options: HumanRenderOptions): string {
  return options.color ? `${code}${value}${ANSI.reset}` : value;
}

function toneColor(tone: NonNullable<HumanDocument['status']>['tone']): string {
  if (tone === 'success') return ANSI.green;
  if (tone === 'warning') return ANSI.yellow;
  if (tone === 'failure') return ANSI.red;
  return ANSI.dim;
}
