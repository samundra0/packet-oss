"use client";

import { useState } from "react";
import { BrandLogo } from "@/components/BrandLogo";
import { getLogoUrl } from "@/lib/branding";
import { useBranding } from "@/hooks/useBranding";

interface TosConsentModalProps {
  token: string;
  currentVersion: string | null;
  onAccept: () => void;
}

export default function TosConsentModal({
  token,
  currentVersion,
  onAccept,
}: TosConsentModalProps) {
  const branding = useBranding();
  const logoUrl = branding?.logoUrl || getLogoUrl();

  const [checked, setChecked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    if (!checked) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/account/tos-accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to record acceptance. Please try again.");
        return;
      }

      onAccept();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg)]">
      <div className="max-w-md w-full mx-4">
        <div className="bg-white rounded-2xl shadow-sm border border-[var(--line)] p-8">
          <div className="flex justify-center mb-6">
            <BrandLogo src={logoUrl} width={140} height={40} />
          </div>

          <h2 className="text-xl font-semibold text-center text-[var(--ink)] mb-2">
            Updated Terms &amp; Conditions
          </h2>

          <p className="text-sm text-[var(--muted)] text-center mb-6">
            We&apos;ve updated our Terms &amp; Conditions
            {currentVersion ? ` (version ${currentVersion})` : ""}.
            Please review and accept to continue using your account.
          </p>

          <div className="flex flex-col gap-3 mb-6">
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="block px-4 py-3 bg-[var(--bg)] rounded-lg border border-[var(--line)] text-sm text-[var(--ink)] hover:bg-[var(--bg-elevated)] transition-colors"
            >
              Legal Policies
              <span className="float-right text-[var(--muted)]">&rarr;</span>
            </a>
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="block px-4 py-3 bg-[var(--bg)] rounded-lg border border-[var(--line)] text-sm text-[var(--ink)] hover:bg-[var(--bg-elevated)] transition-colors"
            >
              Privacy Policies
              <span className="float-right text-[var(--muted)]">&rarr;</span>
            </a>
          </div>

          <label className="flex items-start gap-3 mb-6 cursor-pointer">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-[var(--line)] text-teal-600 focus:ring-teal-500"
            />
            <span className="text-sm text-[var(--ink)]">
              I have read and agree to the updated Legal Policies and Privacy Policies
            </span>
          </label>

          {error && (
            <p className="text-sm text-rose-500 mb-4">{error}</p>
          )}

          <button
            onClick={handleAccept}
            disabled={!checked || isLoading}
            className="w-full px-6 py-3 bg-teal-600 hover:bg-teal-700 disabled:bg-[var(--line)] disabled:text-[var(--muted)] text-white font-medium rounded-lg transition-colors"
          >
            {isLoading ? (
              <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              "Accept & Continue"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
