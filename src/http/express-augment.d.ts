import type { AuthPrincipal } from '../types.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth; present on every authenticated route. */
      principal?: AuthPrincipal;
    }
  }
}

export {};
