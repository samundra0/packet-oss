import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTeam, changeTeamPackage } from '@/lib/hostedai/teams';
import type { CreateTeamParams } from '@/lib/hostedai/types';

// Mock the client module
vi.mock('@/lib/hostedai/client', () => ({
  hostedaiRequest: vi.fn(),
  getApiUrl: vi.fn(async () => 'https://hai.example.com'),
}));

import { hostedaiRequest } from '@/lib/hostedai/client';

const mockRequest = vi.mocked(hostedaiRequest);

// These tests lock in the Titan↔Ariel dual-shape contract for the two team
// endpoints that Ariel broke (see "HAI Ariel compat sweep"): Ariel moved the
// flat top-level policy IDs into a nested `general` object gated by
// `has_general_policies`, and PUT /team/{id} now hard-requires `name`. We send
// BOTH shapes so the same body works on Titan (current prod) and Ariel (later).

const POLICIES = {
  pricing_policy_id: 'pricing-1',
  resource_policy_id: 'resource-1',
  service_policy_id: 'service-1',
  instance_type_policy_id: 'instance-type-1',
  image_policy_id: 'image-1',
};

describe('createTeam — Titan/Ariel dual-shape policy body', () => {
  beforeEach(() => mockRequest.mockReset());

  it('sends both flat policy keys (Titan) and nested general + has_general_policies (Ariel)', async () => {
    mockRequest.mockResolvedValueOnce({ id: 'team-1' } as never);

    const params: CreateTeamParams = {
      name: 'Acme Team',
      members: [{ email: 'a@example.com', role: 'team_admin' }],
      ...POLICIES,
    };
    await createTeam(params);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [method, path, body] = mockRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/team');

    // Titan: flat top-level keys still present
    expect(body).toMatchObject(POLICIES);

    // Ariel: nested general set + gate flag
    expect(body).toMatchObject({
      has_general_policies: true,
      general: POLICIES,
    });
  });
});

describe('changeTeamPackage — Titan/Ariel dual-shape + name round-trip', () => {
  beforeEach(() => mockRequest.mockReset());

  it('round-trips the current team name and sends both flat + nested policy shapes', async () => {
    // 1st call: getTeam (GET /team/{id}) → returns current name
    mockRequest.mockResolvedValueOnce({ id: 'team-9', name: 'Existing Name' } as never);
    // 2nd call: the PUT
    mockRequest.mockResolvedValueOnce(undefined as never);

    await changeTeamPackage('team-9', POLICIES);

    expect(mockRequest).toHaveBeenCalledTimes(2);

    const [getMethod, getPath] = mockRequest.mock.calls[0];
    expect(getMethod).toBe('GET');
    expect(getPath).toBe('/team/team-9');

    const [putMethod, putPath, putBody] = mockRequest.mock.calls[1];
    expect(putMethod).toBe('PUT');
    expect(putPath).toBe('/team/team-9');
    // Ariel requires a non-empty name; we round-trip the existing one (no rename)
    expect(putBody).toMatchObject({ name: 'Existing Name' });
    // Titan: flat keys; Ariel: nested general + gate flag
    expect(putBody).toMatchObject({ ...POLICIES, has_general_policies: true, general: POLICIES });
  });

  it('still issues the PUT (without name) if the team name lookup fails', async () => {
    mockRequest.mockRejectedValueOnce(new Error('HAI down'));
    mockRequest.mockResolvedValueOnce(undefined as never);

    await expect(changeTeamPackage('team-9', POLICIES)).resolves.toBeUndefined();

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [, , putBody] = mockRequest.mock.calls[1];
    expect(putBody).not.toHaveProperty('name');
    expect(putBody).toMatchObject({ has_general_policies: true, general: POLICIES });
  });
});
