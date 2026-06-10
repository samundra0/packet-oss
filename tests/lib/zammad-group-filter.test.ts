import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the settings layer used by zammadFetch's getConfig().
vi.mock("@/lib/settings", () => ({
  getSettings: vi.fn().mockResolvedValue({
    ZAMMAD_API_URL: "https://zammad.test",
    ZAMMAD_API_TOKEN: "test-token",
  }),
}));

import { getPacketGroupIds, __resetPacketGroupIdsCache } from "@/lib/zammad";

/**
 * PA-182: customer-side ticket scope must include EVERY packet support queue,
 * not just an exact-name allowlist. Default `ZAMMAD_GROUP_NAMES` pattern is
 * `packet.ai` — a case-insensitive substring match — so when Support adds a
 * Billing/Commercial/Refunds queue named like `Support::Billing - packet.ai`
 * customer-side endpoints pick it up automatically and tickets moved there
 * stay visible.
 */
describe("getPacketGroupIds (PA-182)", () => {
  beforeEach(() => {
    __resetPacketGroupIdsCache();
    vi.restoreAllMocks();
  });

  function mockGroups(groups: { id: number; name: string }[]) {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(groups), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  it("matches every group whose name contains 'packet.ai' by default", async () => {
    mockGroups([
      { id: 1, name: "Support::L1 - packet.ai" },
      { id: 2, name: "Support::Escalated - packet.ai" },
      { id: 3, name: "Support::Billing - packet.ai" },
      { id: 4, name: "Support::Commercial - packet.ai" },
      { id: 99, name: "Internal::Tools" },
      { id: 100, name: "Support::L1 - hosted.ai" },
    ]);

    const ids = await getPacketGroupIds();

    expect(ids.sort()).toEqual([1, 2, 3, 4]);
    expect(ids).not.toContain(99);
    expect(ids).not.toContain(100);
  });

  it("is case-insensitive on the group name", async () => {
    mockGroups([
      { id: 1, name: "Support::L1 - PACKET.AI" },
      { id: 2, name: "Support::Billing - Packet.Ai" },
      { id: 3, name: "Internal::Other" },
    ]);

    const ids = await getPacketGroupIds();
    expect(ids.sort()).toEqual([1, 2]);
  });

  it("does not cache an empty result so a transient Zammad outage can recover", async () => {
    mockGroups([{ id: 99, name: "Unrelated::Group" }]);
    const first = await getPacketGroupIds();
    expect(first).toEqual([]);

    // Second call: Zammad is back up, group list now contains packet queues.
    mockGroups([{ id: 1, name: "Support::L1 - packet.ai" }]);
    const second = await getPacketGroupIds();
    expect(second).toEqual([1]);
  });

  it("caches a successful lookup (one fetch across repeated calls)", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify([{ id: 7, name: "Support::L1 - packet.ai" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    expect(await getPacketGroupIds()).toEqual([7]);
    expect(await getPacketGroupIds()).toEqual([7]);
    expect(await getPacketGroupIds()).toEqual([7]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
