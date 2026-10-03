// Outgoing email (verification, password reset).
//
// Production: the SMTP settings come from a systemd encrypted credential. systemd decrypts it
// only into this service's private, RAM-only folder ($CREDENTIALS_DIRECTORY) at start. The
// secret is never in an environment variable, a config file, or the repository.
//
// Development (no credential): each email goes to the console, and to DEV_MAIL_DIR as JSON if set.

import fs from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true: implicit TLS (465). false: STARTTLS (587)
  user: string;
  pass: string;
  from: string; // e.g. "Draw <noreply@bsums.xyz>"
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class Mailer {
  private transport: Transporter | null = null;
  private from = 'Draw <noreply@localhost>';
  readonly mode: 'smtp' | 'dev';

  constructor() {
    const dir = process.env.CREDENTIALS_DIRECTORY;
    const file = dir ? path.join(dir, 'smtp') : null;
    let cfg: Partial<SmtpConfig> = {};
    if (file && fs.existsSync(file)) {
      try {
        cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        console.error('mail: the smtp credential is not valid JSON');
      }
    }
    if (cfg.host && cfg.user && cfg.pass && cfg.port) {
      this.transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: !!cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
        requireTLS: !cfg.secure, // never send the password in clear text
      });
      this.from = cfg.from ?? `Draw <${cfg.user}>`;
      this.mode = 'smtp';
    } else {
      this.mode = 'dev';
      if (process.env.NODE_ENV === 'production') {
        console.warn('mail: no SMTP credential (systemd credential "smtp"); emails are only logged');
      }
    }
  }

  async send(mail: Mail): Promise<void> {
    if (this.transport) {
      await this.transport.sendMail({ from: this.from, ...mail });
      return;
    }
    console.log(`\n--- mail to ${mail.to}: ${mail.subject}\n${mail.text}\n---`);
    const dir = process.env.DEV_MAIL_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}-${mail.to}.json`), JSON.stringify(mail, null, 2));
    }
  }

  /** Checks the SMTP login at start, so a bad credential shows in the log at once. */
  async verify(): Promise<void> {
    if (!this.transport) return;
    try {
      await this.transport.verify();
      console.log('mail: SMTP login OK');
    } catch (e) {
      console.error('mail: SMTP login failed:', (e as Error).message);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A short email with one button. */
export function actionMail(to: string, subject: string, intro: string, button: string, url: string, outro: string): Mail {
  return {
    to,
    subject,
    text: `${intro}\n\n${button}: ${url}\n\n${outro}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#222">
<h2 style="margin:0 0 16px">Draw</h2>
<p>${escapeHtml(intro)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#1971c2;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(button)}</a></p>
<p style="color:#666;font-size:13px">${escapeHtml(outro)}</p>
<p style="color:#999;font-size:12px">Or open this link: ${escapeHtml(url)}</p>
</div>`,
  };
}
