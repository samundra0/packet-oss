/**
 * Admin Email Broadcast API
 *
 * GET  - List all broadcasts ordered by createdAt desc
 * POST - Preview recipients, send test email, or send broadcast
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { sendEmailDirect } from "@/lib/email/client";
import { emailLayout, delay } from "@/lib/email/utils";
import { readPoolOverviewCache } from "@/lib/pool-overview";
import fs from "fs";
import path from "path";

// ── File-based logging (bypasses console.log routing issues) ────────────────

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "broadcast.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function broadcastLog(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  console.log(`[Broadcast] ${message}`);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    // Rotate if too large
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        const rotated = LOG_FILE + ".1";
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(LOG_FILE, rotated);
      }
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Silently fail if file logging doesn't work
  }
}

// ── Recipient resolution ────────────────────────────────────────────────────

interface Recipient {
  email: string;
  name: string;
}

async function resolveRecipients(
  segmentType: string,
  segmentFilter?: Record<string, unknown>
): Promise<Recipient[]> {
  const recipientMap = new Map<string, Recipient>();

  const addRecipient = (email: string, name: string) => {
    const key = email.toLowerCase();
    if (!recipientMap.has(key)) {
      recipientMap.set(key, { email: key, name });
    }
  };

  switch (segmentType) {
    case "all": {
      const customers = await prisma.customerCache.findMany({
        where: { isDeleted: false, email: { not: null } },
      });
      for (const c of customers) {
        if (c.email) addRecipient(c.email, c.name || "");
      }
      break;
    }

    case "active": {
      const customers = await prisma.customerCache.findMany({
        where: { isDeleted: false, email: { not: null }, activePods: { gt: 0 } },
      });
      for (const c of customers) {
        if (c.email) addRecipient(c.email, c.name || "");
      }
      break;
    }

    case "pool": {
      const poolIds = (segmentFilter?.poolIds as number[]) || [];
      if (poolIds.length === 0) break;

      const overview = readPoolOverviewCache();
      if (!overview) break;

      const matchingPools = overview.pools.filter((p) => poolIds.includes(p.id));
      const emails = new Set<string>();

      for (const pool of matchingPools) {
        for (const pod of pool.pods) {
          if (pod.customerEmail) {
            emails.add(pod.customerEmail.toLowerCase());
          }
        }
      }

      // Look up names from CustomerCache
      if (emails.size > 0) {
        const customers = await prisma.customerCache.findMany({
          where: { email: { in: Array.from(emails) }, isDeleted: false },
        });
        const nameMap = new Map<string, string>();
        for (const c of customers) {
          if (c.email) nameMap.set(c.email.toLowerCase(), c.name || "");
        }
        for (const email of emails) {
          addRecipient(email, nameMap.get(email) || "");
        }
      }
      break;
    }

    case "node": {
      const nodeIds = (segmentFilter?.nodeIds as string[]) || [];
      if (nodeIds.length === 0) break;

      // Look up ProviderNode to get gpuaasPoolId for each node
      const providerNodes = await prisma.providerNode.findMany({
        where: { id: { in: nodeIds }, gpuaasPoolId: { not: null } },
      });
      const poolIds = providerNodes
        .map((n) => n.gpuaasPoolId)
        .filter((id): id is number => id !== null);

      if (poolIds.length === 0) break;

      // Reuse pool logic
      const overview = readPoolOverviewCache();
      if (!overview) break;

      const matchingPools = overview.pools.filter((p) => poolIds.includes(p.id));
      const emails = new Set<string>();

      for (const pool of matchingPools) {
        for (const pod of pool.pods) {
          if (pod.customerEmail) {
            emails.add(pod.customerEmail.toLowerCase());
          }
        }
      }

      if (emails.size > 0) {
        const customers = await prisma.customerCache.findMany({
          where: { email: { in: Array.from(emails) }, isDeleted: false },
        });
        const nameMap = new Map<string, string>();
        for (const c of customers) {
          if (c.email) nameMap.set(c.email.toLowerCase(), c.name || "");
        }
        for (const email of emails) {
          addRecipient(email, nameMap.get(email) || "");
        }
      }
      break;
    }

    case "billing": {
      const billingType = segmentFilter?.billingType as string | undefined;
      if (!billingType) break;

      const customers = await prisma.customerCache.findMany({
        where: { isDeleted: false, email: { not: null }, billingType },
      });
      for (const c of customers) {
        if (c.email) addRecipient(c.email, c.name || "");
      }
      break;
    }

    case "product": {
      const productId = segmentFilter?.productId as string | undefined;
      if (!productId) break;

      const customers = await prisma.customerCache.findMany({
        where: { isDeleted: false, email: { not: null }, productId },
      });
      for (const c of customers) {
        if (c.email) addRecipient(c.email, c.name || "");
      }
      break;
    }

    case "custom": {
      const emails = (segmentFilter?.emails as string[]) || [];
      if (emails.length === 0) break;

      const normalizedEmails = emails.map((e) => e.toLowerCase());

      // Look up names from CustomerCache where possible
      const customers = await prisma.customerCache.findMany({
        where: { email: { in: normalizedEmails }, isDeleted: false },
      });
      const nameMap = new Map<string, string>();
      for (const c of customers) {
        if (c.email) nameMap.set(c.email.toLowerCase(), c.name || "");
      }

      for (const email of normalizedEmails) {
        addRecipient(email, nameMap.get(email) || "");
      }
      break;
    }

    default:
      break;
  }

  return Array.from(recipientMap.values());
}

// ── Auto-convert plain text newlines to <br> ────────────────────────────────

function autoLineBreaks(html: string): string {
  // If the content contains block-level HTML tags, assume it's authored HTML
  if (/<(p|div|table|tr|td|h[1-6]|ul|ol|li|br|hr)\b/i.test(html)) return html;
  // Otherwise treat as plain text and convert newlines
  return html.replace(/\n/g, "<br>\n");
}

// ── Variable substitution ───────────────────────────────────────────────────

function substituteVars(
  template: string,
  recipient: Recipient
): string {
  return template
    .replace(/\{\{customerName\}\}/g, recipient.name || "")
    .replace(/\{\{customerEmail\}\}/g, recipient.email);
}

// ── GET handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  broadcastLog("GET handler called");
  try {
    const sessionToken = request.cookies.get("admin_session")?.value;
    if (!sessionToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const session = verifySessionToken(sessionToken);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const broadcasts = await prisma.emailBroadcast.findMany({
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ success: true, data: broadcasts });
  } catch (err) {
    broadcastLog(`GET error: ${err}`);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ── POST handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  broadcastLog("POST handler called");
  try {
    const sessionToken = request.cookies.get("admin_session")?.value;
    if (!sessionToken) {
      broadcastLog("No admin_session cookie");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const session = verifySessionToken(sessionToken);
    if (!session) {
      broadcastLog("Invalid session token");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const adminEmail = session.email;
    const body = await request.json();
    const { action } = body;
    broadcastLog(`Action: ${action}, admin: ${adminEmail}`);

    switch (action) {
      // ── Preview: resolve recipients and return count + sample ────────
      case "preview": {
        const { segmentType, segmentFilter } = body;

        if (!segmentType) {
          return NextResponse.json(
            { error: "segmentType is required" },
            { status: 400 }
          );
        }

        const recipients = await resolveRecipients(segmentType, segmentFilter);
        const sampleEmails = recipients.slice(0, 10).map((r) => r.email);

        return NextResponse.json({
          success: true,
          data: { count: recipients.length, sampleEmails },
        });
      }

      // ── Send test: send a single email to testEmail ─────────────────
      case "send-test": {
        const { subject, htmlBody, useLayout, testEmail } = body;

        if (!subject || !htmlBody || !testEmail) {
          return NextResponse.json(
            { error: "subject, htmlBody, and testEmail are required" },
            { status: 400 }
          );
        }

        broadcastLog(`Sending test email to ${testEmail}, subject: "${subject}", useLayout: ${useLayout}, bodyLen: ${htmlBody.length}`);

        const processedBody = autoLineBreaks(htmlBody);
        const finalHtml = useLayout
          ? emailLayout({ body: processedBody, isTransactional: false })
          : processedBody;

        try {
          await sendEmailDirect({
            to: testEmail,
            subject,
            html: finalHtml,
            text: subject,
          });
          broadcastLog(`Test email sent successfully to ${testEmail}`);
        } catch (emailErr) {
          broadcastLog(`Test email FAILED to ${testEmail}: ${emailErr instanceof Error ? emailErr.message : emailErr}`);
          return NextResponse.json(
            { error: `Email delivery failed: ${emailErr instanceof Error ? emailErr.message : "Unknown error"}` },
            { status: 500 }
          );
        }

        return NextResponse.json({ success: true });
      }

      // ── Send broadcast: create record, send to all recipients ───────
      case "send": {
        const {
          subject,
          htmlBody,
          textBody,
          useLayout,
          segmentType,
          segmentFilter,
        } = body;

        if (!subject || !htmlBody || !segmentType) {
          return NextResponse.json(
            { error: "subject, htmlBody, and segmentType are required" },
            { status: 400 }
          );
        }

        // Resolve recipients before creating the record
        const recipients = await resolveRecipients(segmentType, segmentFilter);

        if (recipients.length === 0) {
          return NextResponse.json(
            { error: "No recipients match the selected segment" },
            { status: 400 }
          );
        }

        // Create broadcast record with status "sending"
        const broadcast = await prisma.emailBroadcast.create({
          data: {
            subject,
            htmlBody,
            textBody: textBody || null,
            useLayout: useLayout ?? true,
            segmentType,
            segmentFilter: segmentFilter ? JSON.stringify(segmentFilter) : null,
            recipientCount: recipients.length,
            sentCount: 0,
            failedCount: 0,
            status: "sending",
            createdBy: adminEmail,
          },
        });

        // Send emails one by one (non-blocking after response)
        // We run this inline so the caller gets the broadcast ID immediately
        // but the sending happens in the background via a detached promise
        const broadcastId = broadcast.id;

        // Fire-and-forget: send all emails in the background
        (async () => {
          let sentCount = 0;
          let failedCount = 0;

          for (const recipient of recipients) {
            try {
              const finalSubject = substituteVars(subject, recipient);
              const substitutedBody = autoLineBreaks(substituteVars(htmlBody, recipient));
              const finalHtml = useLayout
                ? emailLayout({ body: substitutedBody, isTransactional: false })
                : substitutedBody;
              const finalText = textBody
                ? substituteVars(textBody, recipient)
                : finalSubject;

              await sendEmailDirect({
                to: recipient.email,
                subject: finalSubject,
                html: finalHtml,
                text: finalText,
              });

              sentCount++;
            } catch (err) {
              broadcastLog(`Broadcast ${broadcastId}: failed to send to ${recipient.email}: ${err}`);
              failedCount++;
            }

            // Update progress after each send
            await prisma.emailBroadcast.update({
              where: { id: broadcastId },
              data: { sentCount, failedCount },
            });

            await delay(1000);
          }

          // Final status update
          await prisma.emailBroadcast.update({
            where: { id: broadcastId },
            data: {
              sentCount,
              failedCount,
              status: failedCount === recipients.length ? "failed" : "sent",
              sentAt: new Date(),
            },
          });

          broadcastLog(`Broadcast ${broadcastId} complete: ${sentCount} sent, ${failedCount} failed`);
        })().catch((err) => {
          broadcastLog(`Broadcast ${broadcastId} fatal error: ${err}`);
          // Mark as failed if the entire loop crashes
          prisma.emailBroadcast
            .update({
              where: { id: broadcastId },
              data: { status: "failed" },
            })
            .catch(() => {});
        });

        return NextResponse.json({ success: true, data: broadcast });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    broadcastLog(`POST error: ${err}`);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
