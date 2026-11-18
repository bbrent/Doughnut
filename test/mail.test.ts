import { describe, expect, it, vi } from 'vitest';
import { AccountService } from '../src/server/accounts';
import { describeSmtpError, maskEmail, mailerFromEnv, type Email, type Mailer, type MailStatus } from '../src/server/mailer';
import { MemoryRepo } from '../src/server/store';

class FailingMailer implements Mailer {
  readonly delivers = true;
  tries = 0;
  async send(_e: Email) {
    this.tries++;
    throw Object.assign(new Error('Invalid login: 535 Incorrect authentication data'), { code: 'EAUTH', responseCode: 535 });
  }
  async verify() {}
  status(): MailStatus {
    return { mode: 'smtp', check: 'failed' };
  }
}

describe('email problems are visible', () => {
  it('explains common SMTP errors', () => {
    expect(describeSmtpError(Object.assign(new Error('Invalid login: 535 Incorrect authentication data'), { code: 'EAUTH', responseCode: 535 }))).toMatch(
      /EAUTH.*check SMTP_USER/,
    );
    expect(describeSmtpError(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ESOCKET' }))).toMatch(/certificate does not match/);
    expect(describeSmtpError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:465'), { code: 'ESOCKET' }))).toMatch(/could not connect/);
    expect(maskEmail('jane.doe@example.com')).toBe('j***@example.com');
  });

  it('a failed send tells the player at sign-up, but not for "forgot password" (privacy)', async () => {
    const mail = new FailingMailer();
    const svc = new AccountService(new MemoryRepo(), mail, { publicUrl: 'https://x.test' });
    await expect(svc.signup('tokenAAAAAAAAAAAAAAAA', 'a@example.com', 'Ann', 'secret12')).rejects.toThrow(/couldn't send the email/);
    await expect(svc.requestPasswordReset('a@example.com')).resolves.toBeUndefined();
  });

  it('a send skipped by the per-address limit is logged', async () => {
    const sent: Email[] = [];
    const mailer: Mailer = { delivers: true, send: async (e) => void sent.push(e), verify: async () => {}, status: () => ({ mode: 'smtp', check: 'ok' }) };
    const svc = new AccountService(new MemoryRepo(), mailer, { publicUrl: 'https://x.test' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await svc.signup('tokenAAAAAAAAAAAAAAAA', 'a@example.com', 'Ann', 'secret12');
    await svc.resendVerification('a@example.com');
    expect(sent).toHaveLength(1);
    expect(log.mock.calls.some((c) => /skipped.*a\*\*\*@example\.com|a\*\*\*@example\.com.*skipped/.test(String(c[0])))).toBe(true);
    log.mockRestore();
  });

  it('SMTP_SECURE accepts true / True / yes / 1, and defaults to TLS on port 465', () => {
    const secure = (env: Record<string, string>) => (mailerFromEnv({ SMTP_HOST: 'h', ...env }).status() as MailStatus).server;
    expect(secure({ SMTP_PORT: '465' })).toMatch(/\(TLS\)/);
    expect(secure({ SMTP_PORT: '465', SMTP_SECURE: 'True' })).toMatch(/\(TLS\)/);
    expect(secure({ SMTP_PORT: '587' })).toMatch(/STARTTLS/);
    expect(secure({ SMTP_PORT: '587', SMTP_SECURE: 'false' })).toMatch(/STARTTLS/);
  });
});
