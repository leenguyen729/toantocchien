/**
 * Best-effort masking of credential-shaped substrings in free text that is
 * about to be stored (incident evidence, notes). It is a safety net, not a
 * licence to pass secrets around: callers should never put secrets in text.
 */
const PATTERNS: RegExp[] = [
  /\b(access_token|client_secret|api[_-]?key|password|passwd|secret|token)\s*[=:]\s*[^\s&"',;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi,
  /\bEAA[A-Za-z0-9]{20,}\b/g,
  /\bshp(at|ca|pa|ss)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
];

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((t, re) => t.replace(re, '[REDACTED]'), text);
}
