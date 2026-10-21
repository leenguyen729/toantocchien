import { DomainError } from '@pod/contracts';
import type { CapabilityInfo, MetaWriteAdapter } from './types';

/**
 * Placeholder for the real Meta Marketing API adapter.
 *
 * Deliberately unimplemented: API version, endpoints, fields, enums and
 * permissions are not verified (see docs/api-capabilities/meta.md). Every
 * method fails closed with CAPABILITY_UNSUPPORTED so that no code path can
 * mistake this for a working live integration or return mock data as real.
 */
export class UnverifiedLiveMetaAdapter implements MetaWriteAdapter {
  readonly kind = 'live' as const;
  private fail(): never {
    throw new DomainError('CAPABILITY_UNSUPPORTED', 'Live Meta adapter chưa được nghiệm thu; xem docs/api-capabilities/meta.md');
  }
  listEntities(): never {
    this.fail();
  }
  getEntity(): never {
    this.fail();
  }
  findByIdempotencyTag(): never {
    this.fail();
  }
  capabilities(): Promise<CapabilityInfo> {
    this.fail();
  }
  create(): never {
    this.fail();
  }
  update(): never {
    this.fail();
  }
}
