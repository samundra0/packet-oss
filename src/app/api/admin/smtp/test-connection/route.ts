import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import nodemailer from "nodemailer";
import { autoDetectTls } from "@/lib/email/client";
import { getSetting } from "@/lib/settings";

/**
 * POST /api/admin/smtp/test-connection
 * Verifies SMTP connectivity using the settings from the request body.
 * This allows testing BEFORE saving — the form sends current field values.
 */
export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const host = body.host?.trim();
    const port = parseInt(body.port || "587", 10);
    const user = body.user?.trim() || undefined;

    // The password field in the UI shows a masked value (e.g. "somepass****") when
    // the user hasn't re-typed it in the current editing session. If we detect a
    // masked value, fall back to the stored password so the test succeeds — the
    // user only changed the username, not the password.
    let pass: string | undefined = body.password || undefined;
    if (typeof pass === "string" && pass.endsWith("****")) {
      pass = (await getSetting("SMTP_PASSWORD")) || undefined;
    }

    if (!host) {
      return NextResponse.json(
        { ok: false, error: "SMTP host is required." },
        { status: 400 },
      );
    }

    if (isNaN(port) || port < 1 || port > 65535) {
      return NextResponse.json(
        { ok: false, error: `Invalid port: ${body.port}` },
        { status: 400 },
      );
    }

    const { secure, requireTLS } = autoDetectTls(port);

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS,
      auth: user ? { user, pass: pass || "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });

    await transporter.verify();
    transporter.close();

    return NextResponse.json({ ok: true, transport: "smtp" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 400 },
    );
  }
}
