// SPDX-License-Identifier: AGPL-3.0-or-later
// SMTP send for the `imap` mail plugin, via nodemailer (implicit SSL on 465, STARTTLS otherwise).
import nodemailer from 'nodemailer';

export class MailSendError extends Error {}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export async function sendMail(
  cfg: SmtpConfig,
  opts: { to: string[]; subject: string; body: string; cc?: string[] },
): Promise<void> {
  if (opts.to.length === 0) throw new MailSendError('at least one recipient is required');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  try {
    await transport.sendMail({
      from: cfg.from,
      to: opts.to,
      ...(opts.cc && opts.cc.length > 0 ? { cc: opts.cc } : {}),
      subject: opts.subject,
      text: opts.body,
    });
  } catch (exc) {
    throw new MailSendError(`SMTP send failed: ${exc instanceof Error ? exc.message : String(exc)}`);
  } finally {
    transport.close();
  }
}
