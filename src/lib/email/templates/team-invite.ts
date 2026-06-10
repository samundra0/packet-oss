import { sendEmail } from "../client";
import {
  escapeHtml,
  emailLayout,
  emailGreeting,
  emailText,
  emailButtonTeal,
  emailInfoBox,
  emailMuted,
  emailSignoff,
} from "../utils";
import { getBrandName, getDashboardUrl } from "@/lib/branding";

export async function sendTeamInviteEmail(params: {
  to: string;
  roleDisplayName: string;
  inviterName: string;
  inviterEmail: string;
  accountLabel: string;
  token: string;
  expiresAt: Date;
}) {
  const {
    to,
    roleDisplayName,
    inviterName,
    inviterEmail,
    accountLabel,
    token,
    expiresAt,
  } = params;

  const inviteUrl = `${getDashboardUrl()}/invite/${token}`;
  const brand = getBrandName();
  const safeRole = escapeHtml(roleDisplayName);
  const safeInviter = escapeHtml(inviterName || inviterEmail);
  const safeInviterEmail = escapeHtml(inviterEmail);
  const safeAccount = escapeHtml(accountLabel);
  const expiry = expiresAt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const subject = `${safeInviter} invited you to ${safeAccount} on ${brand}`;

  const body = `
    ${emailGreeting("there")}
    ${emailText(
      `<strong>${safeInviter}</strong> (${safeInviterEmail}) has invited you to join <strong>${safeAccount}</strong> on ${brand} as a <strong>${safeRole}</strong>.`,
    )}
    ${emailText("Click below to accept the invitation:")}
    ${emailButtonTeal("Accept invitation", inviteUrl)}
    ${emailInfoBox(
      `<p style="margin:0;font-size:14px;color:#0b0f1c;"><strong>Role:</strong> ${safeRole}</p>
       <p style="margin:6px 0 0 0;font-size:14px;color:#0b0f1c;"><strong>Account:</strong> ${safeAccount}</p>
       <p style="margin:6px 0 0 0;font-size:14px;color:#0b0f1c;"><strong>Expires:</strong> ${expiry}</p>`,
    )}
    ${emailText(
      "If you weren't expecting this invitation you can safely ignore this email — no account will be created.",
    )}
    ${emailMuted(
      `If the button doesn't work, paste this link into your browser:<br/><a href="${inviteUrl}" style="color:#1a4fff;word-break:break-all;">${inviteUrl}</a>`,
    )}
    ${emailSignoff()}
  `;

  const html = emailLayout({
    preheader: `${inviterName || inviterEmail} invited you to ${accountLabel} as ${roleDisplayName}`,
    body,
  });
  const text = `Hi,

${inviterName || inviterEmail} (${inviterEmail}) invited you to join ${accountLabel} on ${brand} as a ${roleDisplayName}.

Accept here: ${inviteUrl}

This invitation expires on ${expiry}. If you weren't expecting it, you can ignore this email.`;

  await sendEmail({ to, subject, html, text });
}
