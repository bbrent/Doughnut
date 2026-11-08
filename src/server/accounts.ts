/**
 * Account rules: sign up with email + nickname + password, confirm the email
 * through a one-time link, log in with email or nickname, and reset a
 * forgotten password through a one-time link. Guests (no account) are never
 * stored.
 *
 * Privacy: sign-up and "forgot password" answer the same way whether or not
 * an email has an account; the owner of an existing account is told by email.
 */
import { randomBytes } from 'node:crypto';
import { AccountError, cleanNickname, type AccountInfo, type Accounts } from '../game/lobby';
import type { GameRecord } from '../game/protocol';
import { linkEmail, type Mailer } from './mailer';
import { LoginThrottle, checkNewPassword, hashPassword, verifyPassword } from './password';
import { emailKey, profileOf, sha256, type FriendLists, type LeaderRow, type PlayerRow, type Repo } from './store';

export interface AccountOptions {
  /** Base URL for links in emails, e.g. https://doughnut.example.com */
  publicUrl: string;
  verifyTtlMs: number;
  resetTtlMs: number;
  now: () => number;
}

export const DEFAULT_ACCOUNT_OPTIONS: Omit<AccountOptions, 'publicUrl'> = {
  verifyTtlMs: 48 * 3600_000,
  resetTtlMs: 3600_000,
  now: Date.now,
};

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
export const validEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e.trim());

const info = (p: PlayerRow): AccountInfo => ({ id: String(p.id), nickname: p.nickname, profile: profileOf(p) });

/** At most one email per address per minute, and five per hour. */
class SendLimiter {
  private log = new Map<string, number[]>();
  constructor(private readonly now: () => number) {}
  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.log.get(key) ?? []).filter((x) => t - x < 3600_000);
    if (recent.length >= 5 || (recent.length && t - recent[recent.length - 1] < 60_000)) return false;
    recent.push(t);
    this.log.set(key, recent);
    return true;
  }
}

export class AccountService implements Accounts {
  private readonly o: AccountOptions;
  private throttle: LoginThrottle;
  private sends: SendLimiter;

  constructor(
    readonly repo: Repo,
    private readonly mailer: Mailer,
    opts: Partial<AccountOptions> & { publicUrl: string },
  ) {
    this.o = { ...DEFAULT_ACCOUNT_OPTIONS, ...opts, publicUrl: opts.publicUrl.replace(/\/+$/, '') };
    this.throttle = new LoginThrottle(this.o.now);
    this.sends = new SendLimiter(this.o.now);
  }

  init() {
    return this.repo.init();
  }
  close() {
    return this.repo.close();
  }
  leaderboard(limit: number): Promise<LeaderRow[]> {
    return this.repo.leaderboard(limit);
  }
  recordGame(rec: GameRecord) {
    return this.repo.recordGame(rec);
  }

  // ---- sessions ----------------------------------------------------------

  async sessionAccount(token: string) {
    const p = await this.repo.sessionPlayer(sha256(token));
    return p?.verified_at ? info(p) : null;
  }

  /** Guests may not use the nickname of a confirmed account. */
  async isRegistered(nickname: string) {
    return !!(await this.repo.byNickname(nickname))?.verified_at;
  }

  async logout(token: string) {
    await this.repo.unlinkSession(sha256(token));
  }

  // ---- sign up and verify --------------------------------------------------

  private async newLink(playerId: number, purpose: 'verify' | 'reset'): Promise<string> {
    const code = randomBytes(24).toString('base64url');
    const ttl = purpose === 'verify' ? this.o.verifyTtlMs : this.o.resetTtlMs;
    await this.repo.addLink(sha256(code), playerId, purpose, new Date(this.o.now() + ttl));
    return `${this.o.publicUrl}/?${purpose}=${code}`;
  }

  private async sendVerify(p: PlayerRow) {
    if (!p.email || !this.sends.allow(emailKey(p.email))) return;
    const link = await this.newLink(p.id, 'verify');
    await this.mailer.send(
      linkEmail(
        p.email,
        'Confirm your Doughnut account',
        [`Hi ${p.nickname},`, 'Confirm your email address to finish signing up. Your games and rating are saved from then on.'],
        link,
        'Confirm my email',
        ['This link works once and expires in 48 hours.', "If you didn't sign up for Doughnut, ignore this email and nothing happens."],
      ),
    );
  }

  /**
   * Create an unconfirmed account and email a confirmation link. Throws for
   * problems the person should fix (bad email, weak password, nickname taken).
   * Returns the pending account id, or null when the email already had an
   * account (its owner gets an email instead). Either way the caller should
   * just say "check your email".
   */
  async signup(token: string, email: string, nickname: string, password: string): Promise<string | null> {
    email = email.trim();
    const nick = cleanNickname(nickname);
    if (!validEmail(email)) throw new AccountError("That doesn't look like an email address");
    if (nick.length < 2) throw new AccountError('Pick a nickname of at least 2 characters');
    if (/^guest$/i.test(nick)) throw new AccountError(`"${nick}" can't be registered. Pick another nickname.`);
    const bad = checkNewPassword(password);
    if (bad) throw new AccountError(bad);

    await this.repo.purgeUnverified(this.o.verifyTtlMs);
    const existing = await this.repo.byEmail(email);
    if (existing?.verified_at) {
      // Don't reveal that the email has an account; tell its owner instead.
      if (this.sends.allow(emailKey(email))) {
        const link = await this.newLink(existing.id, 'reset');
        await this.mailer.send(
          linkEmail(
            existing.email!,
            'You already have a Doughnut account',
            [`Someone (hopefully you) tried to sign up with this email, but it already has an account: ${existing.nickname}.`, 'Forgotten your password? Choose a new one here:'],
            link,
            'Reset my password',
            ['This link works once and expires in 1 hour.', "If this wasn't you, ignore this email: your account hasn't changed."],
          ),
        );
      }
      return null;
    }
    // A newer sign-up for the same email replaces an unconfirmed one.
    if (existing) await this.repo.deleteAccount(existing.id);

    const id = await this.repo.createAccount({ email, nickname: nick, passwordHash: await hashPassword(password) });
    if (id === 'nickname') throw new AccountError('That nickname is taken. Pick another.');
    if (id === 'email') throw new AccountError('Please try again in a moment');
    // Remember this browser so it is logged in as soon as the email is confirmed.
    await this.repo.linkSession(sha256(token), id);
    await this.sendVerify((await this.repo.byId(id))!);
    return String(id);
  }

  async resendVerification(email: string): Promise<void> {
    const p = await this.repo.byEmail(email);
    if (p && !p.verified_at) await this.sendVerify(p);
  }

  /** Confirm an email from its link and log this browser in. */
  async verifyEmail(token: string, code: string): Promise<AccountInfo> {
    const id = await this.repo.consumeLink(sha256(code), 'verify');
    if (id === null) throw new AccountError('That confirmation link has expired or was already used. Log in, or sign up again.');
    await this.repo.markVerified(id);
    await this.repo.linkSession(sha256(token), id);
    return info((await this.repo.byId(id))!);
  }

  // ---- log in ----------------------------------------------------------------

  async login(token: string, login: string, password: string): Promise<AccountInfo> {
    const isEmail = login.includes('@');
    const key = isEmail ? emailKey(login) : cleanNickname(login).toLowerCase();
    const wait = this.throttle.check(key);
    if (wait) throw new AccountError(`Too many attempts. Try again in ${wait} s.`);
    const p = isEmail ? await this.repo.byEmail(login) : await this.repo.byNickname(login);
    if (!p || !(await verifyPassword(password, p.password_hash))) {
      this.throttle.fail(key);
      throw new AccountError('Wrong email, nickname or password');
    }
    this.throttle.success(key);
    if (!p.verified_at) {
      await this.sendVerify(p);
      throw new AccountError('Please confirm your email first. We sent the link again.');
    }
    await this.repo.linkSession(sha256(token), p.id);
    return info(p);
  }

  // ---- forgotten password ------------------------------------------------------

  /** Email a reset link if the address has an account. Always looks the same to the caller. */
  async requestPasswordReset(email: string): Promise<void> {
    if (!validEmail(email)) throw new AccountError("That doesn't look like an email address");
    const p = await this.repo.byEmail(email);
    if (!p || !this.sends.allow(emailKey(email))) return;
    const link = await this.newLink(p.id, 'reset');
    await this.mailer.send(
      linkEmail(
        p.email!,
        'Reset your Doughnut password',
        [`Hi ${p.nickname},`, 'Choose a new password with this link:'],
        link,
        'Choose a new password',
        ['This link works once and expires in 1 hour.', "If you didn't ask for this, ignore this email: your password hasn't changed."],
      ),
    );
  }

  /** Set a new password from a reset link: logs out everywhere else, logs this browser in. */
  async resetPassword(token: string, code: string, password: string): Promise<AccountInfo> {
    const bad = checkNewPassword(password);
    if (bad) throw new AccountError(bad);
    const id = await this.repo.consumeLink(sha256(code), 'reset');
    if (id === null) throw new AccountError('That reset link has expired or was already used. Ask for a new one.');
    await this.repo.setPassword(id, await hashPassword(password));
    await this.repo.dropLinks(id, 'reset');
    await this.repo.markVerified(id); // the link proves they own the email
    await this.repo.unlinkAllSessions(id);
    await this.repo.linkSession(sha256(token), id);
    const p = (await this.repo.byId(id))!;
    this.throttle.success(emailKey(p.email ?? ''));
    this.throttle.success(p.nickname.toLowerCase());
    return info(p);
  }

  // ---- friends -----------------------------------------------------------------

  async friendLists(accountId: string): Promise<FriendLists> {
    return this.repo.friendLists(Number(accountId));
  }

  /** A confirmed account by nickname, other than the asker. */
  private async friendTarget(accountId: string, nickname: string): Promise<PlayerRow> {
    const p = await this.repo.byNickname(nickname);
    if (!p?.verified_at) throw new AccountError(`No player called "${cleanNickname(nickname)}". Only signed-up players can be friends.`);
    if (String(p.id) === accountId) throw new AccountError("That's you!");
    return p;
  }

  async addFriend(accountId: string, nickname: string) {
    const p = await this.friendTarget(accountId, nickname);
    const lists = await this.repo.friendLists(Number(accountId));
    if (lists.friends.length + lists.outgoing.length >= 200) throw new AccountError('Your friends list is full (200)');
    const state = await this.repo.requestFriend(Number(accountId), p.id);
    return { other: { id: String(p.id), nickname: p.nickname }, state };
  }

  async respondFriend(accountId: string, nickname: string, accept: boolean) {
    const p = await this.friendTarget(accountId, nickname);
    if (accept) {
      if (!(await this.repo.acceptFriend(p.id, Number(accountId)))) throw new AccountError(`${p.nickname} hasn't asked to be friends`);
    } else {
      await this.repo.removeFriendship(p.id, Number(accountId));
    }
    return { id: String(p.id), nickname: p.nickname };
  }

  async removeFriend(accountId: string, nickname: string) {
    const p = await this.friendTarget(accountId, nickname);
    await this.repo.removeFriendship(Number(accountId), p.id);
    return { id: String(p.id), nickname: p.nickname };
  }
}
