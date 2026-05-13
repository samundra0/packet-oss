import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

function getPackageVersion(): string {
  try {
    return readFileSync(join(process.cwd(), "VERSION"), "utf-8").trim();
  } catch {
    return "";
  }
}

// Marketing site lives at packet.ai (separate repo). 301 redirect any
// marketing URLs that still resolve on dash to their canonical home so we
// don't compete with packet.ai for the same SEO surface.
const MARKETING_HOST =
  process.env.NEXT_PUBLIC_MARKETING_URL?.replace(/\/$/, "") || "https://packet.ai";

const MARKETING_PATHS = [
  "about",
  "blackwell",
  "blog",
  "cli",
  "clusters",
  "contact",
  "demand",
  "features",
  "for-providers",
  "gpu",
  "privacy",
  "providers/apply",
  "pxl",
  "request-quote",
  "sla",
  "technology",
  "terms",
  "token-factory",
  "use-cases",
  "vs",
];

function marketingRedirects() {
  return MARKETING_PATHS.flatMap((p) => [
    {
      source: `/${p}`,
      destination: `${MARKETING_HOST}/${p}`,
      permanent: true,
    },
    {
      source: `/${p}/:path*`,
      destination: `${MARKETING_HOST}/${p}/:path*`,
      permanent: true,
    },
  ]);
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["nodemailer"],
  env: {
    NEXT_PUBLIC_APP_VERSION: getPackageVersion(),
  },
  output: "standalone",
  images: {
    dangerouslyAllowSVG: true,
    contentDispositionType: "inline",
    remotePatterns: [
      {
        protocol: "https",
        hostname: process.env.NEXT_PUBLIC_APP_HOSTNAME || "packet.ai",
      },
    ],
  },
  async redirects() {
    return marketingRedirects();
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "on",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
