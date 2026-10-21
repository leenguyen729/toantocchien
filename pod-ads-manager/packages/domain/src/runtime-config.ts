import { randomBytes } from 'node:crypto';
import { DomainError, type Mode } from '@pod/contracts';

export type RuntimeConfig = {
  mode: Mode;
  liveWritesEnabled: boolean;
  accountAllowlist: string[];
  signingKey: { key_id: string; secret: Buffer; ephemeral: boolean };
  isCI: boolean;
};

/**
 * Parse process env. Defaults are the safe ones (mock, writes off). Anything
 * ambiguous throws instead of guessing. CI can never run outside mock.
 */
export function loadRuntimeConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const mode = (env.EXECUTION_MODE ?? 'mock') as Mode;
  if (!['mock', 'read_only', 'approval'].includes(mode)) throw new Error(`EXECUTION_MODE không hợp lệ: ${mode}`);
  const liveRaw = env.LIVE_WRITES_ENABLED ?? 'false';
  if (liveRaw !== 'true' && liveRaw !== 'false') throw new Error('LIVE_WRITES_ENABLED phải là "true" hoặc "false"');
  const liveWritesEnabled = liveRaw === 'true';
  const isCI = !!env.CI && env.CI !== 'false';
  const accountAllowlist = (env.META_ACCOUNT_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (isCI && (mode !== 'mock' || liveWritesEnabled)) {
    throw new DomainError('PERMISSION_DENIED', 'CI chỉ được chạy EXECUTION_MODE=mock với LIVE_WRITES_ENABLED=false');
  }
  if (liveWritesEnabled && mode !== 'approval') throw new Error('LIVE_WRITES_ENABLED=true chỉ có nghĩa ở EXECUTION_MODE=approval');
  if (mode === 'approval' && liveWritesEnabled && accountAllowlist.length === 0) {
    throw new Error('approval + live writes cần META_ACCOUNT_ALLOWLIST do operator cấu hình');
  }

  const secretHex = env.APPROVAL_SIGNING_KEY;
  let signingKey: RuntimeConfig['signingKey'];
  if (secretHex) {
    if (!/^[a-f0-9]{64,}$/.test(secretHex)) throw new Error('APPROVAL_SIGNING_KEY phải là hex >= 32 bytes');
    signingKey = { key_id: env.APPROVAL_SIGNING_KEY_ID ?? 'k1', secret: Buffer.from(secretHex, 'hex'), ephemeral: false };
  } else if (mode === 'mock') {
    // Mock only: per-process key, never persisted. Approvals do not survive a restart, which is acceptable for demos.
    signingKey = { key_id: 'ephemeral-mock', secret: randomBytes(32), ephemeral: true };
  } else {
    throw new Error('APPROVAL_SIGNING_KEY bắt buộc ngoài mock mode (lấy từ vault)');
  }
  return { mode, liveWritesEnabled, accountAllowlist, signingKey, isCI };
}
