import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { signAccessToken } from '../auth/tokens.js';
import type { UserRepository } from '../db/users.js';
import { type AuthPrincipal, type User, errors } from '../types.js';

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

export interface AuthResult {
  user: User;
  token: string;
  expiresInSeconds: number;
}

export class AuthService {
  constructor(private readonly users: UserRepository) {}

  private static toPrincipal(user: User): AuthPrincipal {
    return { userId: user.id, username: user.username, role: user.role };
  }

  private issue(user: User): AuthResult {
    return {
      user,
      token: signAccessToken(AuthService.toPrincipal(user)),
      expiresInSeconds: config.jwt.ttlSeconds,
    };
  }

  async register(username: string, password: string): Promise<AuthResult> {
    const trimmed = username.trim();

    if (!USERNAME_PATTERN.test(trimmed)) {
      throw errors.invalid(
        'Username must be 3-32 characters using letters, digits, underscore, dot or dash',
      );
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw errors.invalid(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    // Reserved so that "@all" style mentions can never collide with a real user.
    if (['all', 'here', 'channel', 'everyone'].includes(trimmed.toLowerCase())) {
      throw errors.conflict('That username is reserved');
    }
    if (this.users.findByUsername(trimmed)) {
      throw errors.conflict('Username is already taken');
    }

    const user = this.users.create(trimmed, await hashPassword(password));
    return this.issue(user);
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const record = this.users.getPasswordHash(username.trim());

    // Same error and roughly the same work either way, so the response does not
    // reveal whether an account exists.
    if (!record) {
      await hashPassword(password);
      throw errors.unauthorized('Invalid username or password');
    }
    if (!(await verifyPassword(password, record.passwordHash))) {
      throw errors.unauthorized('Invalid username or password');
    }
    if (record.user.isBanned) {
      throw errors.forbidden('This account is banned');
    }

    return this.issue(record.user);
  }

  /**
   * Re-reads the user behind a verified token. Tokens are stateless, so this is
   * what makes a ban take effect before the token's own expiry.
   */
  resolvePrincipal(principal: AuthPrincipal): User {
    const user = this.users.findById(principal.userId);
    if (!user) throw errors.unauthorized('Account no longer exists');
    if (user.isBanned) throw errors.forbidden('This account is banned');
    return user;
  }

  /** Creates the configured admin on first boot. No-op if the name is taken. */
  async ensureBootstrapAdmin(): Promise<User | null> {
    const { username, password } = config.bootstrapAdmin;
    if (this.users.findByUsername(username)) return null;

    return this.users.create(username, await hashPassword(password), 'admin');
  }
}
