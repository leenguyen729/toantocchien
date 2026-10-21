import { migrateDatabase } from '@pod/domain/pg';

/** `pnpm db:migrate` — apply packages/domain/migrations/*.sql in order. Never enables writes. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Thiếu DATABASE_URL (ví dụ postgres://pod:<mật khẩu>@127.0.0.1:5432/pod_dev)');
  process.exit(1);
}
const applied = await migrateDatabase(url);
console.log(applied.length ? `Đã áp dụng: ${applied.join(', ')}` : 'Không có migration mới.');
