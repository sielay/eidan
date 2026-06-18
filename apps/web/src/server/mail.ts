// SPDX-License-Identifier: AGPL-3.0-or-later
// Magic-link email. Sends via SMTP when EIDAN_SMTP_HOST is set; otherwise returns sent:false so the
// caller echoes the link/code in the response (dev — no mailer needed). Every outcome is logged and a
// failure returns its reason (never throws), so a misconfigured mailer is observable and non-locking.
import nodemailer from "nodemailer";

export async function sendMagicLink(to: string, link: string, code: string): Promise<{ sent: boolean; error?: string }> {
  const host = process.env.EIDAN_SMTP_HOST;
  if (!host) {
    console.warn("[mail] EIDAN_SMTP_HOST unset — magic link not emailed (echo mode)");
    return { sent: false };
  }

  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.EIDAN_SMTP_PORT ?? 587),
    secure: process.env.EIDAN_SMTP_SECURE === "1",
    auth: process.env.EIDAN_SMTP_USER
      ? { user: process.env.EIDAN_SMTP_USER, pass: process.env.EIDAN_SMTP_PASSWORD ?? "" }
      : undefined,
  });

  try {
    const info = await transport.sendMail({
      from: process.env.EIDAN_SMTP_FROM ?? "eidan <no-reply@eidan.local>",
      to,
      subject: "Your eidan sign-in link",
      text: `Sign in to eidan:\n\n${link}\n\nOr enter this code: ${code}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
      html: `<p>Sign in to eidan:</p><p><a href="${link}">${link}</a></p><p>Or enter this code: <strong>${code}</strong></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
    });
    console.log(`[mail] magic link sent to ${to} via ${host} (id: ${info.messageId ?? "?"}, accepted: ${info.accepted?.length ?? 0})`);
    return { sent: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[mail] magic link send FAILED to ${to} via ${host}: ${error}`);
    return { sent: false, error };
  }
}
