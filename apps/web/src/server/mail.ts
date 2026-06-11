// SPDX-License-Identifier: AGPL-3.0-or-later
// Magic-link email. Sends via SMTP when EIDAN_SMTP_HOST is set; otherwise returns sent:false so the
// caller echoes the link/code in the response (dev — no mailer needed).
import nodemailer from "nodemailer";

export async function sendMagicLink(to: string, link: string, code: string): Promise<{ sent: boolean }> {
  const host = process.env.EIDAN_SMTP_HOST;
  if (!host) return { sent: false };

  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.EIDAN_SMTP_PORT ?? 587),
    secure: process.env.EIDAN_SMTP_SECURE === "1",
    auth: process.env.EIDAN_SMTP_USER
      ? { user: process.env.EIDAN_SMTP_USER, pass: process.env.EIDAN_SMTP_PASS ?? "" }
      : undefined,
  });

  await transport.sendMail({
    from: process.env.EIDAN_SMTP_FROM ?? "eidan <no-reply@eidan.local>",
    to,
    subject: "Your eidan sign-in link",
    text: `Sign in to eidan:\n\n${link}\n\nOr enter this code: ${code}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
    html: `<p>Sign in to eidan:</p><p><a href="${link}">${link}</a></p><p>Or enter this code: <strong>${code}</strong></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
  });
  return { sent: true };
}
