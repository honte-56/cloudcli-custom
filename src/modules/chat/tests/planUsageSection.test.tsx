import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import PlanUsageSection from '@/modules/chat/modals/PlanUsageSection';

const planUsage = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { providers: { planUsage: (...args: unknown[]) => planUsage(...args) } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      options ? `${key}:${JSON.stringify(options)}` : key
    ),
  }),
}));

const respond = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe('PlanUsageSection', () => {
  afterEach(() => {
    planUsage.mockReset();
  });

  it('requests usage for the conversation provider and renders each window', async () => {
    planUsage.mockResolvedValue(respond({
      provider: 'codex',
      status: 'ok',
      planName: 'Pro',
      windows: [{ id: 'weekly', windowMinutes: 10080, usedPercent: 94, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() }],
      credits: null,
      source: 'session-log',
      fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    }));

    render(<PlanUsageSection provider="codex" />);

    await waitFor(() => assert.ok(screen.getByRole('progressbar')));
    assert.equal(planUsage.mock.calls[0][0], 'codex');
    assert.equal(screen.getByRole('progressbar').getAttribute('aria-valuenow'), '94');
  });

  it('shows the unavailable message instead of bars when the login has expired', async () => {
    planUsage.mockResolvedValue(respond({
      provider: 'claude', status: 'token-expired', planName: null, windows: [], credits: null, source: null, fetchedAt: null,
    }));

    render(<PlanUsageSection provider="claude" />);

    await waitFor(() => assert.ok(screen.getByText('planUsage.status.token-expired:{"defaultValue":""}')));
    assert.equal(screen.queryByRole('progressbar'), null);
  });

  it('renders nothing and makes no request for providers without plan usage', () => {
    const { container } = render(<PlanUsageSection provider="cursor" />);

    assert.equal(container.firstChild, null);
    assert.equal(planUsage.mock.calls.length, 0);
  });
});
