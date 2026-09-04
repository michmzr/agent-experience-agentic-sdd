export const cursorCaptureDiagnosticCategories = [
  'invalid-working-directory',
  'persistence-failure',
  'unsafe-command-shape',
  'unsupported-tool'
] as const;

export type CursorCaptureDiagnosticCategory =
  (typeof cursorCaptureDiagnosticCategories)[number];
