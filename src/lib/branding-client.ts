/**
 * Client-safe branding helpers.
 *
 * Mirrors the public API of @/lib/branding but resolves only against
 * NEXT_PUBLIC_* env vars + edition defaults — never reaches into
 * settings.ts / prisma / fs / crypto. Safe to import from any Client
 * Component without dragging server-only deps into the browser bundle.
 *
 * If you need DB-backed runtime overrides (set via the admin Platform
 * Settings UI), import from @/lib/branding instead — but only from
 * server components, API routes, or server-only modules.
 */

import { isOSS } from "./edition";

const PRO_DEFAULTS = {
  brandName: "Packet.ai",
  appUrl: "https://packet.ai",
  dashboardUrl: "https://dash.packet.ai",
  apiBaseUrl: "https://api.packet.ai",
  supportEmail: "help@packet.ai",
  logoUrl: "/packet-logo.png",
  faviconUrl: "/favicon.ico",
  primaryColor: "#1a4fff",
  accentColor: "#18b6a8",
  backgroundColor: "#f7f8fb",
  textColor: "#0b0f1c",
  companyName: "Hosted AI Inc.",
  companyAddress: "622 North 9th Street, San Jose, CA 95112, USA",
} as const;

const OSS_DEFAULTS = {
  brandName: "GPU Cloud Dashboard",
  appUrl: "http://localhost:3000",
  dashboardUrl: "http://localhost:3000",
  apiBaseUrl: "http://localhost:3000/api",
  supportEmail: "admin@localhost",
  logoUrl: "/logo.svg",
  faviconUrl: "/favicon.ico",
  primaryColor: "#1a4fff",
  accentColor: "#18b6a8",
  backgroundColor: "#f7f8fb",
  textColor: "#0b0f1c",
  companyName: "",
  companyAddress: "",
} as const;

function defaults() {
  return isOSS() ? OSS_DEFAULTS : PRO_DEFAULTS;
}

function env(key: string): string | undefined {
  return process.env[key] || undefined;
}

function cleanLocalUrl(url: string): string {
  if (url.startsWith("/") && url.includes("?")) {
    return url.split("?")[0];
  }
  return url;
}

export function getBrandName(): string {
  return env("NEXT_PUBLIC_BRAND_NAME") || defaults().brandName;
}

export function getAppUrl(): string {
  return env("NEXT_PUBLIC_APP_URL") || defaults().appUrl;
}

export function getDashboardUrl(): string {
  return (
    env("NEXT_PUBLIC_DASHBOARD_URL") ||
    env("NEXT_PUBLIC_APP_URL") ||
    defaults().dashboardUrl
  );
}

export function getApiBaseUrl(): string {
  return env("NEXT_PUBLIC_API_BASE_URL") || defaults().apiBaseUrl;
}

export function getSupportEmail(): string {
  return env("SUPPORT_EMAIL") || defaults().supportEmail;
}

export function getLogoUrl(): string {
  return cleanLocalUrl(env("NEXT_PUBLIC_LOGO_URL") || defaults().logoUrl);
}

export function getFaviconUrl(): string {
  return cleanLocalUrl(env("NEXT_PUBLIC_FAVICON_URL") || defaults().faviconUrl);
}

export function getPrimaryColor(): string {
  return env("NEXT_PUBLIC_PRIMARY_COLOR") || defaults().primaryColor;
}

export function getAccentColor(): string {
  return env("NEXT_PUBLIC_ACCENT_COLOR") || defaults().accentColor;
}

export function getBackgroundColor(): string {
  return env("NEXT_PUBLIC_BACKGROUND_COLOR") || defaults().backgroundColor;
}

export function getTextColor(): string {
  return env("NEXT_PUBLIC_TEXT_COLOR") || defaults().textColor;
}

export function getCompanyName(): string {
  return env("COMPANY_NAME") || defaults().companyName;
}

export function getCompanyAddress(): string {
  return env("COMPANY_ADDRESS") || defaults().companyAddress;
}

export interface BrandConfig {
  brandName: string;
  appUrl: string;
  dashboardUrl: string;
  apiBaseUrl: string;
  supportEmail: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  companyName: string;
  companyAddress: string;
  emailFromName: string;
  emailFromAddress: string;
  emailFooterText: string;
}
