// @vitest-environment jsdom
//
// PA-180: when a search returns zero matches, the Hugging Face tab silently
// fell back to rendering the Popular / RTX / Models / Spaces browse view —
// users perceived this as "search returned irrelevant results" because the
// page still had content but none of it matched their query.
//
// This test pins the empty-state behaviour: after a search that yields no
// results, the user sees an explicit "no results" message and the default
// browse tabs are hidden.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Stub heavy children so we only exercise the tab's own render branches.
vi.mock("@/app/dashboard/components/LaunchGPUModal", () => ({
  LaunchGPUModal: () => null,
}));
vi.mock("@/components/huggingface-tab/ItemCard", () => ({
  ItemCard: ({ item }: { item: { id: string } }) => (
    <div data-testid="item-card">{item.id}</div>
  ),
}));
vi.mock("@/components/huggingface-tab/FilterPanel", () => ({
  FilterPanel: () => null,
}));
vi.mock("@/components/huggingface-tab/MemoryModal", () => ({
  MemoryModal: () => null,
}));

import HuggingFaceTab from "@/components/HuggingFaceTab";

type FetchResponseBody = Record<string, unknown>;

function mockFetchSequence(responses: FetchResponseBody[]) {
  const fetchMock = vi.fn();
  for (const body of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => body,
    });
  }
  // Any further fetches (catalog refreshes etc.) return empty payloads.
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("HuggingFaceTab — search empty state (PA-180)", () => {
  it("shows a 'no results' message when the API returns an empty result set", async () => {
    // First fetch is the initial catalog load; second is the search.
    mockFetchSequence([
      { items: [] }, // catalog load
      { results: [], total: 0, filterOptions: null }, // search response
    ]);

    render(<HuggingFaceTab token="test-token" />);

    const input = await screen.findByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "xyznonexistentmodel123" } });

    const searchButton = screen.getByRole("button", { name: /^search$/i });
    fireEvent.click(searchButton);

    // The empty-state message must appear and quote the query the user typed.
    await waitFor(() => {
      expect(
        screen.getByText(/no models found/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/xyznonexistentmodel123/)).toBeInTheDocument();

    // The browse-tabs fallback must NOT be visible during an empty search.
    expect(
      screen.queryByRole("button", { name: /^popular$/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the browse tabs before any search has been run", async () => {
    mockFetchSequence([{ items: [] }]);

    render(<HuggingFaceTab token="test-token" />);

    // Pre-search the default Popular / RTX / Models / Spaces browse tabs
    // should be visible.
    expect(
      await screen.findByRole("button", { name: /^popular$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no models found/i)).not.toBeInTheDocument();
  });

  it("renders the result grid when the API returns matches", async () => {
    mockFetchSequence([
      { items: [] },
      {
        results: [
          {
            id: "meta-llama/Llama-3.1-8B-Instruct",
            name: "Llama 3.1 8B Instruct",
            description: "test",
            author: "meta-llama",
            downloads: 100,
            likes: 1,
            gated: false,
            tags: [],
            estimatedVramGb: 16,
            estimatedDiskSizeGb: 0,
            type: "model",
            source: "huggingface",
          },
        ],
        total: 1,
        filterOptions: null,
      },
    ]);

    render(<HuggingFaceTab token="test-token" />);

    const input = await screen.findByPlaceholderText(/search/i);
    fireEvent.change(input, { target: { value: "llama" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("item-card")).toBeInTheDocument();
    });
    expect(screen.queryByText(/no models found/i)).not.toBeInTheDocument();
  });
});
