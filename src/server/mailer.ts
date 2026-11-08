/**
 * Outgoing email. SmtpMailer for production (your host's SMTP server);
 * LogMailer prints emails to the server log instead (development, or when
 * SMTP isn't configured) and keeps them for tests.
 */
export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
  /** Whether emails really leave the server. */
  readonly delivers: boolean;
}

export class LogMailer implements Mailer {
  readonly delivers = false;
  sent: Email[] = [];
  constructor(private readonly quiet = false) {}
  async send(email: Email) {
    this.sent.push(email);
    if (!this.quiet) console.log(`[email not sent: SMTP not configured] To: ${email.to}\nSubject: ${email.subject}\n${email.text}\n`);
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** true for port 465 (TLS from the start); false uses STARTTLS when offered. */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export class SmtpMailer implements Mailer {
  readonly delivers = true;
  private transport: import('nodemailer').Transporter | null = null;
  constructor(private readonly o: SmtpOptions) {}

  async send(email: Email) {
    if (!this.transport) {
      const nodemailer = await import('nodemailer');
      this.transport = nodemailer.createTransport({
        host: this.o.host,
        port: this.o.port,
        secure: this.o.secure,
        auth: this.o.user ? { user: this.o.user, pass: this.o.pass } : undefined,
      });
    }
    await this.transport.sendMail({ from: this.o.from, ...email });
  }
}

export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  if (!env.SMTP_HOST) return new LogMailer();
  const port = Number(env.SMTP_PORT ?? 587);
  return new SmtpMailer({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM ?? env.SMTP_USER ?? 'doughnut@localhost',
  });
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Plain, readable emails with one button-style link. */
export function linkEmail(to: string, subject: string, intro: string[], link: string, linkText: string, outro: string[]): Email {
  const text = [...intro, '', link, '', ...outro].join('\n');
  const p = (l: string) => `<p style="margin:0 0 12px">${escHtml(l)}</p>`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#1d2320;max-width:520px">
    <h2 style="margin:0 0 12px">Doughnut</h2>
    ${intro.map(p).join('')}
    <p style="margin:18px 0"><a href="${escHtml(link)}" style="background:#d9822b;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${escHtml(linkText)}</a></p>
    <p style="margin:0 0 12px;font-size:13px;color:#5f6b66">Or copy this link: ${escHtml(link)}</p>
    ${outro.map((l) => `<p style="margin:0 0 8px;font-size:13px;color:#5f6b66">${escHtml(l)}</p>`).join('')}
  </div>`;
  return { to, subject, text, html };
}
