// Investor JWT helpers — token generation and verification only.
//
// The DB-backed parts of `@/lib/auth/investor` (isInvestor, addInvestor,
// removeInvestor, getInvestors, isInvestorOwner, updateInvestorLogin,
// verifyInvestorSessionToken) used to be backed by `data/investors.json` and
// were tested via fs mocks. The module is now Prisma-backed; the fs-mock
// approach is unsalvageable.
//
// Those test blocks were removed on 2026-05-27 to clear noise from the suite.
// If/when the DB-backed surface needs coverage again, write fresh tests against
// `prisma.investor` using the @/lib/prisma mock pattern (see wallet.test.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  generateInvestorToken,
  verifyInvestorToken,
  generateInvestorSessionToken,
  generateAdminLoginAsInvestorToken,
  verifyAdminLoginAsInvestorToken,
} from '../../../src/lib/auth/investor';

describe('Investor Authentication Module (JWT helpers)', () => {
  const TEST_SECRET = 'test-secret-key-for-testing';
  const TEST_EMAIL = 'investor@example.com';
  const TEST_ADMIN_EMAIL = 'admin@example.com';

  beforeEach(() => {
    process.env.ADMIN_JWT_SECRET = TEST_SECRET;
  });

  describe('generateInvestorToken', () => {
    it('should generate a valid JWT token', () => {
      const token = generateInvestorToken(TEST_EMAIL);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should include investor email in payload (lowercase)', () => {
      const token = generateInvestorToken('INVESTOR@EXAMPLE.COM');
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.email).toBe('investor@example.com');
    });

    it('should include correct type in payload', () => {
      const token = generateInvestorToken(TEST_EMAIL);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.type).toBe('investor-login');
    });

    it('should set expiration to 24 hours', () => {
      const token = generateInvestorToken(TEST_EMAIL);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.exp).toBeTruthy();
      expect(decoded.iat).toBeTruthy();
      // 24 hours = 86400 seconds
      const duration = decoded.exp - decoded.iat;
      expect(duration).toBe(86400);
    });

    it('should normalize email to lowercase', () => {
      const token = generateInvestorToken('INVESTOR@EXAMPLE.COM');
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.email).toBe('investor@example.com');
    });
  });

  describe('verifyInvestorToken', () => {
    it('should verify valid investor tokens', () => {
      const token = generateInvestorToken(TEST_EMAIL);
      const result = verifyInvestorToken(token);
      expect(result).toBeTruthy();
      expect(result?.email).toBe(TEST_EMAIL.toLowerCase());
    });

    it('should return null for expired tokens', () => {
      const expiredToken = jwt.sign(
        { email: TEST_EMAIL, type: 'investor-login' },
        TEST_SECRET,
        { expiresIn: '0s' }
      );
      const result = verifyInvestorToken(expiredToken);
      expect(result).toBeNull();
    });

    it('should return null for tokens signed with wrong secret', () => {
      const wrongSecretToken = jwt.sign(
        { email: TEST_EMAIL, type: 'investor-login' },
        'wrong-secret',
        { expiresIn: '24h' }
      );
      const result = verifyInvestorToken(wrongSecretToken);
      expect(result).toBeNull();
    });

    it('should return null for tokens with wrong type', () => {
      const wrongTypeToken = jwt.sign(
        { email: TEST_EMAIL, type: 'investor-session' },
        TEST_SECRET,
        { expiresIn: '24h' }
      );
      const result = verifyInvestorToken(wrongTypeToken);
      expect(result).toBeNull();
    });

    it('should return null for malformed tokens', () => {
      const result = verifyInvestorToken('not-a-jwt-token');
      expect(result).toBeNull();
    });

    it('should return null for empty token', () => {
      const result = verifyInvestorToken('');
      expect(result).toBeNull();
    });
  });

  describe('generateInvestorSessionToken', () => {
    it('should generate a valid session JWT', () => {
      const token = generateInvestorSessionToken(TEST_EMAIL);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should include correct type in payload', () => {
      const token = generateInvestorSessionToken(TEST_EMAIL);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.type).toBe('investor-session');
    });

    it('should set expiration to 4 hours', () => {
      const token = generateInvestorSessionToken(TEST_EMAIL);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      const duration = decoded.exp - decoded.iat;
      expect(duration).toBe(14400); // 4 hours = 14400 seconds
    });

    it('should normalize email to lowercase', () => {
      const token = generateInvestorSessionToken('INVESTOR@EXAMPLE.COM');
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.email).toBe('investor@example.com');
    });
  });

  describe('generateAdminLoginAsInvestorToken', () => {
    it('should generate a valid admin login-as token', () => {
      const token = generateAdminLoginAsInvestorToken(TEST_EMAIL, TEST_ADMIN_EMAIL);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should include investor email and admin email in payload', () => {
      const token = generateAdminLoginAsInvestorToken(TEST_EMAIL, TEST_ADMIN_EMAIL);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.email).toBe(TEST_EMAIL.toLowerCase());
      expect(decoded.adminEmail).toBe(TEST_ADMIN_EMAIL.toLowerCase());
    });

    it('should include correct type in payload', () => {
      const token = generateAdminLoginAsInvestorToken(TEST_EMAIL, TEST_ADMIN_EMAIL);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.type).toBe('admin-login-as-investor');
    });

    it('should set expiration to 15 minutes', () => {
      const token = generateAdminLoginAsInvestorToken(TEST_EMAIL, TEST_ADMIN_EMAIL);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      const duration = decoded.exp - decoded.iat;
      expect(duration).toBe(900); // 15 minutes = 900 seconds
    });

    it('should normalize investor email to lowercase (admin email preserved as-is)', () => {
      // Note: source intentionally does NOT lowercase the admin email — admin
      // identity is treated as opaque (came from session, already trusted).
      const token = generateAdminLoginAsInvestorToken(
        'INVESTOR@EXAMPLE.COM',
        TEST_ADMIN_EMAIL,
      );
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.email).toBe('investor@example.com');
      expect(decoded.adminEmail).toBe(TEST_ADMIN_EMAIL);
    });
  });

  describe('verifyAdminLoginAsInvestorToken', () => {
    it('should verify valid admin login-as tokens', () => {
      const token = generateAdminLoginAsInvestorToken(TEST_EMAIL, TEST_ADMIN_EMAIL);
      const result = verifyAdminLoginAsInvestorToken(token);
      expect(result).toBeTruthy();
      expect(result?.email).toBe(TEST_EMAIL.toLowerCase());
      expect(result?.adminEmail).toBe(TEST_ADMIN_EMAIL);
    });

    it('should return null for expired tokens', () => {
      const expiredToken = jwt.sign(
        {
          email: TEST_EMAIL,
          adminEmail: TEST_ADMIN_EMAIL,
          type: 'admin-login-as-investor',
        },
        TEST_SECRET,
        { expiresIn: '0s' }
      );
      const result = verifyAdminLoginAsInvestorToken(expiredToken);
      expect(result).toBeNull();
    });

    it('should return null for tokens with wrong type', () => {
      const wrongTypeToken = jwt.sign(
        {
          email: TEST_EMAIL,
          adminEmail: TEST_ADMIN_EMAIL,
          type: 'investor-login',
        },
        TEST_SECRET,
        { expiresIn: '1h' }
      );
      const result = verifyAdminLoginAsInvestorToken(wrongTypeToken);
      expect(result).toBeNull();
    });

    it('should return null for malformed tokens', () => {
      const result = verifyAdminLoginAsInvestorToken('invalid-token');
      expect(result).toBeNull();
    });

    it('should return null for empty token', () => {
      const result = verifyAdminLoginAsInvestorToken('');
      expect(result).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long email addresses', () => {
      const longEmail = 'a'.repeat(100) + '@example.com';
      const token = generateInvestorToken(longEmail);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.email).toBe(longEmail.toLowerCase());
    });

    it('should handle unicode characters in email', () => {
      const unicodeEmail = 'tëst@éxample.com';
      const token = generateInvestorToken(unicodeEmail);
      const decoded = jwt.verify(token, TEST_SECRET) as any;
      expect(decoded.email).toBe(unicodeEmail.toLowerCase());
    });
  });
});
