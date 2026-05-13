/**
 * Item Card Component
 *
 * Card component for displaying HuggingFace model/space items.
 *
 * @module components/huggingface-tab/ItemCard
 */

"use client";

import type { CatalogItem, SearchResult } from "./types";
import { getCompatibilityBadge } from "./helpers";
import { STANDARD_EPHEMERAL_STORAGE_GB } from "@/lib/huggingface-api";

interface ItemCardProps {
  item: CatalogItem | SearchResult;
  onDeploy: (item: CatalogItem | SearchResult) => void;
  onOpenMemoryModal: (modelId: string) => void;
}

export function ItemCard({ item, onDeploy, onOpenMemoryModal }: ItemCardProps) {
  const isGated = "gated" in item && item.gated;
  const vramGb =
    "vramGb" in item
      ? item.vramGb
      : "estimatedVramGb" in item
      ? item.estimatedVramGb
      : 0;
  // Check if this is a real VRAM value from HF API (for catalog items)
  const hasRealVram = "realVramGb" in item && item.realVramGb !== undefined;
  const diskSizeGb =
    "diskSizeGb" in item
      ? item.diskSizeGb
      : "estimatedDiskSizeGb" in item
      ? item.estimatedDiskSizeGb
      : 0;
  const exceedsStorageLimit =
    diskSizeGb !== undefined && diskSizeGb > 0 && diskSizeGb > STANDARD_EPHEMERAL_STORAGE_GB;

  return (
    <div className="bg-white rounded-xl border border-[var(--line)] p-5 hover:shadow-lg transition-shadow">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <h3
            className="font-semibold text-[var(--ink)] truncate"
            title={item.name}
          >
            {item.name}
          </h3>
          <p className="text-xs text-[var(--muted)] truncate" title={item.id}>
            {item.id}
          </p>
        </div>
        {isGated && (
          <span className="text-xs px-2 py-1 bg-orange-100 text-orange-700 rounded-full ml-2 whitespace-nowrap">
            Requires Token
          </span>
        )}
      </div>

      <p className="text-sm text-[var(--muted)] line-clamp-2 mb-3 min-h-[2.5rem]">
        {item.description}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {/* Memory requirement with "read more" link */}
        {vramGb > 0 && (
          <span
            className={`text-xs px-2 py-1 rounded-full inline-flex items-center gap-1 ${
              hasRealVram
                ? "bg-emerald-100 text-emerald-700"
                : "bg-purple-100 text-purple-700"
            }`}
            title={hasRealVram ? "Calculated from model files" : "Estimated"}
          >
            {hasRealVram && (
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            {vramGb}GB VRAM
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenMemoryModal(item.id);
              }}
              className={`hover:underline ml-0.5 ${
                hasRealVram
                  ? "text-emerald-600 hover:text-emerald-800"
                  : "text-purple-500 hover:text-purple-800"
              }`}
            >
              details
            </button>
          </span>
        )}
        {getCompatibilityBadge(item.compatibility)}
        {"source" in item && item.source === "huggingface" && (
          <span className="text-xs px-2 py-1 bg-zinc-100 text-zinc-600 rounded-full">
            HF Hub
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1 mb-4">
        {item.tags?.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="text-xs px-2 py-0.5 bg-zinc-100 text-zinc-600 rounded"
          >
            {tag}
          </span>
        ))}
      </div>

      {exceedsStorageLimit && (
        <div
          className="mb-3 flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
          title={`This model requires ~${diskSizeGb}GB of storage. Standard pods have ${STANDARD_EPHEMERAL_STORAGE_GB}GB ephemeral storage.`}
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          Requires ~{diskSizeGb}GB — exceeds {STANDARD_EPHEMERAL_STORAGE_GB}GB pod limit
        </div>
      )}
      <button
        onClick={() => onDeploy(item)}
        disabled={exceedsStorageLimit}
        className="w-full py-2 px-4 bg-[var(--blue)] text-white rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity text-sm font-medium"
        title={exceedsStorageLimit ? `Model too large for standard pods (requires ~${diskSizeGb}GB)` : undefined}
      >
        Deploy to GPU
      </button>
    </div>
  );
}
