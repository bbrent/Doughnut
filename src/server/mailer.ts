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

/** What /health shows about email (never the password or username). */
export interface MailStatus {
  mode: 'smtp' | 'log';
  server?: string;
  /** Result of logging in to the mail server at startup. */
  check: 'ok' | 'failed' | 'not checked';
  checkError?: string;
  lastSentAt?: string;
  lastError?: { at: string; message: string };
}

export interface Mailer {
  send(email: Email): Promise<void>;
  /** Whether emails really leave the server. */
  readonly delivers: boolean;
  /** Try logging in to the mail server (startup check). */
  verify(): Promise<void>;
  status(): MailStatus;
}

/** "jane@example.com" -> "j***@example.com", for logs. */
export const maskEmail = (e: string) => e.replace(/^(.)[^@]*@/, '$1***@');

export class LogMailer implements Mailer {
  readonly delivers = false;
  sent: Email[] = [];
  constructor(private readonly quiet = false) {}
  async verify() {}
  status(): MailStatus {
    return { mode: 'log', check: 'not checked' };
  }
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
  private st: MailStatus;
  constructor(private readonly o: SmtpOptions) {
    this.st = { mode: 'smtp', server: `${o.host}:${o.port}${o.secure ? ' (TLS)' : ' (STARTTLS)'}`, check: 'not checked' };
  }

  private async t() {
    if (!this.transport) {
      const nodemailer = await import('nodemailer');
      this.transport = nodemailer.createTransport({
        host: this.o.host,
        port: this.o.port,
        secure: this.o.secure,
        auth: this.o.user ? { user: this.o.user, pass: this.o.pass } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      });
    }
    return this.transport;
  }

  status() {
    return { ...this.st };
  }

  async verify() {
    try {
      await (await this.t()).verify();
      this.st.check = 'ok';
      delete this.st.checkError;
      console.log(`Email: logged in to ${this.st.server} as ${this.o.user ?? '(no login)'}`);
    } catch (e) {
      this.st.check = 'failed';
      this.st.checkError = describeSmtpError(e);
      console.error(`Email: could not log in to ${this.st.server}: ${this.st.checkError}`);
    }
  }

  async send(email: Email) {
    try {
      await (await this.t()).sendMail({ from: this.o.from, ...email });
      this.st.lastSentAt = new Date().toISOString();
      console.log(`Email sent: "${email.subject}" to ${maskEmail(email.to)}`);
    } catch (e) {
      const message = describeSmtpError(e);
      this.st.lastError = { at: new Date().toISOString(), message };
      console.error(`Email FAILED: "${email.subject}" to ${maskEmail(email.to)}: ${message}`);
      throw e;
    }
  }
}

/** A readable one-line reason, with a hint for the usual causes. */
export function describeSmtpError(e: unknown): string {
  const err = e as { message?: string; code?: string; responseCode?: number };
  const msg = (err.message ?? String(e)).split('\n')[0].slice(0, 300);
  let hint = '';
  if (err.code === 'EAUTH' || err.responseCode === 535) hint = ' (check SMTP_USER is the full address and SMTP_PASS its password)';
  else if (err.code === 'ESOCKET' && /certificate|altnames|self.signed/i.test(msg)) hint = ' (the mail server certificate does not match SMTP_HOST: try the server name your host gives for SMTP)';
  else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION' || /ECONNREFUSED|timeout/i.test(msg)) hint = ' (could not connect: check SMTP_HOST and SMTP_PORT; 465 needs SMTP_SECURE=true, 587 needs SMTP_SECURE=false)';
  else if (/wrong version number|ssl3_get_record/i.test(msg)) hint = ' (TLS mismatch: port 465 needs SMTP_SECURE=true, 587 needs SMTP_SECURE=false)';
  return `${err.code ? err.code + ': ' : ''}${msg}${hint}`;
}

export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  if (!env.SMTP_HOST) return new LogMailer();
  const port = Number(env.SMTP_PORT ?? 587);
  return new SmtpMailer({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? /^(true|1|yes)$/i.test(env.SMTP_SECURE.trim()) : port === 465,
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
