/**
 * Consent-button parity findings, as terminal text: one line per finding (severity, code,
 * where), then its explanation and fix, indented. See /docs/fair-consent-buttons.
 */
import type { ButtonParityFinding } from '@cookiemunch/sdk';

function where(f: ButtonParityFinding): string {
  const w = f.where ?? {};
  return [
    f.layer === 'banner' ? 'first layer' : `${f.layer} layer`,
    w.view ? `view "${w.view}"` : '',
    w.variant && w.variant !== 'base' ? `variant ${w.variant}` : '',
    w.theme === 'dark' ? 'dark theme' : '',
    w.breakpoint === 'mobile' ? 'mobile' : '',
    w.language ? `language ${w.language}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export function formatDesignWarnings(findings: ButtonParityFinding[]): string {
  return findings
    .map((f) => `${f.severity === 'warning' ? 'warning' : 'notice '}  ${f.code}  ${where(f)}\n    ${f.detail}\n    fix: ${f.fix}`)
    .join('\n');
}

export function countBySeverity(findings: ButtonParityFinding[]): { warnings: number; notices: number } {
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { warnings, notices: findings.length - warnings };
}

export function summaryLine(findings: ButtonParityFinding[]): string {
  const { warnings, notices } = countBySeverity(findings);
  if (warnings + notices === 0) return 'No design warnings: Accept all and Reject all have equal weight.';
  // Notices are hints (wording, custom CSS a live scan must confirm), not proof of a dark pattern.
  if (warnings === 0) {
    return (
      `Design: 0 warnings, ${notices} notice${notices === 1 ? '' : 's'} — worth a look, not a finding that Accept is favoured. ` +
      'See https://cookiemunch.net/docs/fair-consent-buttons'
    );
  }
  return (
    `Design: ${warnings} warning${warnings === 1 ? '' : 's'}, ${notices} notice${notices === 1 ? '' : 's'} — ` +
    'Accept is pushed harder than Reject. Regulators treat that as a dark pattern; make both buttons the same style. ' +
    'See https://cookiemunch.net/docs/fair-consent-buttons'
  );
}
