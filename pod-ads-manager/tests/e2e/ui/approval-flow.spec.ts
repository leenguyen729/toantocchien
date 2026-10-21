import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:4100';

async function login(page: Page, actor: string) {
  await page.goto('/');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByTestId(`login-${actor}`).click();
  await expect(page.getByTestId('mode-banner')).toBeVisible();
}

async function draft(page: Page, entity: string, amount: string): Promise<string> {
  await login(page, 'u_analyst');
  await page.getByTestId('draft-entity').selectOption(entity);
  await page.getByTestId('draft-amount').fill(amount);
  await page.getByTestId('draft-submit').click();
  const result = page.getByTestId('draft-result');
  await expect(result).toContainText('Đã tạo proposal');
  const id = /(prp_[A-Za-z0-9_]+)/.exec((await result.textContent()) ?? '')?.[1];
  expect(id).toBeTruthy();
  return id!;
}

test('banner and dashboard show mode, live flag, source, date, currency, timezone, attribution', async ({ page }) => {
  await login(page, 'u_viewer');
  const banner = page.getByTestId('mode-banner');
  await expect(banner).toContainText('MOCK');
  await expect(banner).toContainText('LIVE_WRITES_ENABLED=false');
  const snaps = page.getByTestId('snapshots');
  await expect(snaps).toContainText('fixture');
  await expect(snaps).toContainText('UNVERIFIED-mock');
  await expect(snaps).toContainText('USD');
  await expect(snaps).toContainText('America/Los_Angeles');
  await expect(snaps).toContainText('7d_click_1d_view');
  await expect(snaps).toContainText('incomplete');
  await expect(page.getByTestId('config-card')).toContainText('owner đã xác nhận');
  // Viewer has no draft tool.
  await expect(page.getByTestId('draft-submit')).toHaveCount(0);
});

test('draft → diff → approve → execute (simulated) → receipt → audit', async ({ page }) => {
  const id = await draft(page, 'adset_demo', '1100');
  await login(page, 'u_approver');
  await page.goto(`/proposals/${id}?revision=1`);
  await expect(page.getByTestId('status-pill').first()).toHaveAttribute('data-status', 'PENDING_APPROVAL');
  const diff = page.getByTestId('diff');
  await expect(diff).toContainText('SET_DAILY_BUDGET');
  await expect(diff).toContainText('10.00 USD');
  await expect(diff).toContainText('11.00 USD');
  await expect(page.getByTestId('impact')).toContainText('1.00 USD');
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('action-result')).toContainText('Duyệt: xong');
  await expect(page.getByTestId('status-pill').first()).toHaveAttribute('data-status', 'APPROVED');
  await page.getByTestId('execute').click();
  await expect(page.getByTestId('action-result')).toContainText('Xin thực thi: xong');
  const drain = page.getByTestId('drain');
  if (await drain.isVisible().catch(() => false)) await drain.click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('receipt')).toContainText('Thành công', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByTestId('receipt')).toContainText('giả lập');
  await expect(page.getByTestId('proposal-audit')).toContainText('approval.approved');
  await page.goto('/audit');
  await expect(page.getByTestId('audit-table')).toContainText('execution.queued');
});

test('reject: proposal ends REJECTED and cannot be executed', async ({ page }) => {
  const id = await draft(page, 'adset_demo_2', '1600');
  await login(page, 'u_approver');
  await page.goto(`/proposals/${id}?revision=1`);
  await page.getByTestId('approval-comment').fill('Chưa đủ dữ liệu');
  await page.getByTestId('reject').click();
  await expect(page.getByTestId('status-pill').first()).toHaveAttribute('data-status', 'REJECTED');
  await expect(page.getByTestId('execute')).toHaveCount(0);
});

test('expiry: an expired proposal shows as expired and approval is refused', async ({ page, request }) => {
  const id = await draft(page, 'adset_demo_2', '1650');
  await login(page, 'u_approver');
  const token = await page.evaluate(() => sessionStorage.getItem('pam_session'));
  const r = await request.post(`${API}/api/mock/clock/advance`, { data: { ms: 31 * 60_000 }, headers: { authorization: `Bearer ${token}` } });
  expect(r.ok()).toBe(true);
  await page.goto(`/proposals/${id}?revision=1`);
  await expect(page.getByTestId('expiry')).toContainText('ĐÃ HẾT HẠN');
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('action-result')).toContainText('APPROVAL_EXPIRED');
  await expect(page.getByTestId('status-pill').first()).toHaveAttribute('data-status', 'EXPIRED');
});

test('permissions: analyst and viewer cannot approve', async ({ page }) => {
  const id = await draft(page, 'adset_demo_2', '1700');
  await page.goto(`/proposals/${id}?revision=1`);
  await expect(page.getByTestId('approve')).toHaveCount(0);
  await login(page, 'u_viewer');
  await page.goto(`/proposals/${id}?revision=1`);
  await expect(page.getByTestId('approve')).toHaveCount(0);
  await expect(page.getByTestId('actions')).toContainText('Chỉ người có vai trò approver');
});

test('kill switch: banner warns running ads keep spending; execution refused; only owner reopens', async ({ page }) => {
  const id = await draft(page, 'adset_demo_2', '1550');
  await login(page, 'u_approver');
  await page.goto(`/proposals/${id}?revision=1`);
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('status-pill').first()).toHaveAttribute('data-status', 'APPROVED');

  await login(page, 'u_operator');
  await page.goto('/ops');
  await expect(page.getByTestId('running-ads-note')).toContainText('VẪN TIẾP TỤC chi tiêu');
  await page.getByTestId('freeze-reason').fill('Spend bất thường (E2E)');
  await page.getByTestId('freeze').click();
  await expect(page.getByTestId('freeze-indicator')).toContainText('ĐANG BẬT');
  await expect(page.getByTestId('mode-banner')).toContainText('VẪN TIẾP TỤC chi tiêu');
  await expect(page.getByTestId('unfreeze')).toHaveCount(0);

  await login(page, 'u_approver');
  await page.goto(`/proposals/${id}?revision=1`);
  await page.getByTestId('execute').click();
  await expect(page.getByTestId('action-result')).toContainText('WRITE_FROZEN');

  await login(page, 'u_owner');
  await page.goto('/ops');
  await page.getByTestId('freeze-reason').fill('Đã kiểm tra xong (E2E)');
  await page.getByTestId('unfreeze').click();
  await expect(page.getByTestId('freeze-indicator')).toContainText('tắt');
});
