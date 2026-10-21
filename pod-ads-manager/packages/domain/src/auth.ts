import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@pod/contracts';
import type { Clock } from './clock';
import type { Principal } from './rbac';
import type { Store } from './store/types';

/** Opaque bearer session. Only the SHA-256 of the token is stored. */
export async function createSession(store: Store, clock: Clock, principal: Principal, ttlSeconds = 8 * 3600): Promise<string> {
  if (principal.kind !== 'human') throw new Error('Sessions are for human principals only');
  const token = randomBytes(32).toString('hex');
  await store.putSession({
    token_hash: sha256Hex(token),
    principal,
    expires_at: new Date(clock.now().getTime() + ttlSeconds * 1000).toISOString(),
  });
  return token;
}

export async function resolveSession(store: Store, clock: Clock, token: string | undefined): Promise<Principal | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const s = await store.getSession(sha256Hex(token));
  if (!s || Date.parse(s.expires_at) <= clock.now().getTime()) return null;
  return s.principal;
}

/**
 * The Claude runtime principal. Built server-side per tenant; the model can
 * neither choose nor widen it. It holds analyst-level grants and the RBAC
 * layer additionally caps it to LLM_ALLOWED permissions (never approve).
 */
export function claudeRuntimePrincipal(tenantId: string, adAccountIds: string[]): Principal {
  return {
    actor_id: 'claude_runtime',
    tenant_id: tenantId,
    kind: 'llm',
    display_name: 'Claude (analyst runtime)',
    grants: [{ role: 'analyst', ad_account_ids: adAccountIds }],
  };
}
