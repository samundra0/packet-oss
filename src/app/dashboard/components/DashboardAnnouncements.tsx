"use client";

import { useState, useEffect, useCallback } from "react";

interface Announcement {
  id: string;
  title: string;
  message: string;
  displayType: "banner" | "modal" | "both";
  dismissible: boolean;
}

interface DashboardAnnouncementsProps {
  token: string;
}

const DISMISSED_KEY = "dismissed_announcements";

function getDismissedIds(): string[] {
  try {
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addDismissedId(id: string): void {
  const current = getDismissedIds();
  if (!current.includes(id)) {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...current, id]));
  }
}

export function DashboardAnnouncements({ token }: DashboardAnnouncementsProps) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [modalShownIds, setModalShownIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setDismissedIds(getDismissedIds());
  }, []);

  useEffect(() => {
    async function fetchAnnouncements() {
      try {
        const res = await fetch("/api/dashboard/announcements", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.announcements)) {
          setAnnouncements(data.announcements);
        }
      } catch {
        // Silently fail — announcements are non-critical
      }
    }

    fetchAnnouncements();
  }, [token]);

  const handleDismiss = useCallback((id: string) => {
    addDismissedId(id);
    setDismissedIds((prev) => [...prev, id]);
  }, []);

  const handleModalClose = useCallback(
    (announcement: Announcement) => {
      setModalShownIds((prev) => new Set(prev).add(announcement.id));
      if (announcement.dismissible) {
        handleDismiss(announcement.id);
      }
    },
    [handleDismiss]
  );

  const visibleAnnouncements = announcements.filter(
    (a) => !a.dismissible || !dismissedIds.includes(a.id)
  );

  const bannerAnnouncements = visibleAnnouncements.filter(
    (a) => a.displayType === "banner" || a.displayType === "both"
  );

  const modalAnnouncements = visibleAnnouncements.filter(
    (a) =>
      (a.displayType === "modal" || a.displayType === "both") &&
      !modalShownIds.has(a.id) &&
      !dismissedIds.includes(a.id)
  );

  if (visibleAnnouncements.length === 0) {
    return null;
  }

  return (
    <>
      {bannerAnnouncements.map((announcement) => (
        <div
          key={`banner-${announcement.id}`}
          style={{
            background: "#1a4fff",
            color: "white",
            padding: "12px 20px",
            borderRadius: "8px",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
            marginBottom: "8px",
            width: "100%",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: "14px" }}>
              {announcement.title}
            </div>
            <div style={{ fontSize: "13px", opacity: 0.9, marginTop: "2px" }}>
              {announcement.message}
            </div>
          </div>
          {announcement.dismissible && (
            <button
              onClick={() => handleDismiss(announcement.id)}
              style={{
                background: "none",
                border: "none",
                color: "white",
                cursor: "pointer",
                padding: "2px 6px",
                fontSize: "18px",
                lineHeight: 1,
                opacity: 0.7,
                flexShrink: 0,
              }}
              aria-label="Dismiss announcement"
            >
              &times;
            </button>
          )}
        </div>
      ))}

      {modalAnnouncements.length > 0 && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              const first = modalAnnouncements[0];
              if (first.dismissible) {
                handleModalClose(first);
              }
            }
          }}
        >
          <div
            style={{
              background: "white",
              color: "#0b0f1c",
              borderRadius: "12px",
              padding: "24px",
              maxWidth: "480px",
              width: "90%",
              textAlign: "center",
            }}
          >
            <h3
              style={{
                margin: "0 0 12px 0",
                fontSize: "18px",
                fontWeight: 700,
              }}
            >
              {modalAnnouncements[0].title}
            </h3>
            <p
              style={{
                margin: "0 0 20px 0",
                fontSize: "14px",
                lineHeight: 1.5,
                color: "#3a3f4b",
              }}
            >
              {modalAnnouncements[0].message}
            </p>
            {modalAnnouncements[0].dismissible && (
              <button
                onClick={() => handleModalClose(modalAnnouncements[0])}
                style={{
                  background: "#1a4fff",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  padding: "10px 24px",
                  fontSize: "14px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Got it
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
