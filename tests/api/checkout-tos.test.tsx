// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/ratelimit', () => ({
  rateLimit: vi.fn().mockReturnValue({ success: true }),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/embargo', () => ({
  embargoCheck: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock('@/lib/stripe', () => ({
  getStripe: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    gpuProduct: { findUnique: vi.fn() },
  },
}));

vi.mock('@/hooks/useBranding', () => ({
  useBranding: () => null,
}));

vi.mock('@/components/BrandLogo', () => ({
  BrandLogo: () => null,
}));

import { POST } from '@/app/api/checkout/route';
import { WelcomeModal } from '@/app/dashboard/components/modals/WelcomeModal';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/checkout — TOS enforcement (PA-147)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when termsAccepted is missing (server-side guard for anonymous signup)', async () => {
    const response = await POST(makeRequest({
      productId: 'prod_monthly_b200',
      email: 'customer@example.com',
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Legal Policies and Privacy Policies/);
  });

  it('accepts when termsAccepted: true is sent', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.gpuProduct.findUnique).mockResolvedValue(null);

    const response = await POST(makeRequest({
      productId: 'prod_monthly_b200',
      email: 'customer@example.com',
      termsAccepted: true,
    }));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Product not found');
  });

  it('allows checkOnly=true without termsAccepted (existing-customer lookup)', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.gpuProduct.findUnique).mockResolvedValue(null);

    const response = await POST(makeRequest({
      productId: 'prod_monthly_b200',
      email: 'customer@example.com',
      checkOnly: true,
    }));

    expect(response.status).toBe(404);
  });
});

describe('WelcomeModal → /api/checkout (PA-147)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends termsAccepted: true when starting monthly checkout', async () => {
    // Stub global fetch so we can inspect the body the modal sends.
    const fetchMock = vi.fn();
    // First call: GET /api/products — return a monthly product so the button renders.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'prod_monthly_b200',
            name: 'B200 Monthly',
            billingType: 'monthly',
            pricePerMonthCents: 19900,
            pricePerHourCents: 27,
            stripePriceId: 'price_123',
          },
        ],
      }),
    });
    // Second call: POST /api/checkout — return a redirect URL.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/abc' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <WelcomeModal
        isOpen={true}
        onClose={() => {}}
        token="test-jwt-token"
        topupLoading={false}
        onTopup={() => {}}
        customerEmail="customer@example.com"
      />
    );

    const btn = await screen.findByText(/Flat Rate Blackwell/i);
    btn.closest('button')!.click();

    await waitFor(() => {
      const checkoutCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url === '/api/checkout'
      );
      expect(checkoutCall).toBeDefined();
      const body = JSON.parse((checkoutCall![1] as RequestInit).body as string);
      // The bug: this field was missing, causing the server to return 400.
      expect(body.termsAccepted).toBe(true);
      expect(body.productId).toBe('prod_monthly_b200');
      expect(body.email).toBe('customer@example.com');
    });
  });
});
