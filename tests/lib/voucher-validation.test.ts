import { describe, it, expect } from "vitest";
import {
  createVoucherSchema,
  updateVoucherSchema,
  firstZodError,
  VOUCHER_CODE_MAX,
  VOUCHER_DESCRIPTION_MAX,
} from "@/lib/voucher/validation";

const base = {
  code: "PROMO",
  name: "Promo",
  creditCents: 5000,
};

const parseCreate = (input: unknown) => createVoucherSchema.safeParse(input);

describe("voucher input validation (PA-173)", () => {
  describe("Bug 1: whitespace-only code/name", () => {
    it("rejects whitespace-only code", () => {
      const r = parseCreate({ ...base, code: "   " });
      expect(r.success).toBe(false);
      if (!r.success) expect(firstZodError(r.error)).toBe("Code is required");
    });

    it("rejects empty code", () => {
      const r = parseCreate({ ...base, code: "" });
      expect(r.success).toBe(false);
      if (!r.success) expect(firstZodError(r.error)).toBe("Code is required");
    });

    it("rejects whitespace-only name", () => {
      const r = parseCreate({ ...base, name: "   " });
      expect(r.success).toBe(false);
      if (!r.success) expect(firstZodError(r.error)).toBe("Name is required");
    });

    it("trims surrounding whitespace from valid code/name", () => {
      const r = parseCreate({ ...base, code: "  promo  ", name: "  Promo  " });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.code).toBe("PROMO");
        expect(r.data.name).toBe("Promo");
      }
    });
  });

  describe("Bug 2: blank code yields required error, not duplicate", () => {
    it("required check fires before any uniqueness check", () => {
      const r = parseCreate({ ...base, code: "" });
      expect(r.success).toBe(false);
      if (!r.success) {
        const msg = firstZodError(r.error);
        expect(msg).toBe("Code is required");
        expect(msg).not.toMatch(/already exists/i);
      }
    });
  });

  describe("Bug 3: date range validation", () => {
    it("rejects year 0001", () => {
      const r = parseCreate({ ...base, startsAt: "0001-01-01" });
      expect(r.success).toBe(false);
    });

    it("rejects year 9999", () => {
      const r = parseCreate({ ...base, expiresAt: "9999-01-01" });
      expect(r.success).toBe(false);
    });

    it("accepts dates within 2020-2099", () => {
      const r = parseCreate({ ...base, startsAt: "2026-01-01", expiresAt: "2027-12-31" });
      expect(r.success).toBe(true);
    });

    it("rejects startsAt after expiresAt", () => {
      const r = parseCreate({ ...base, startsAt: "2027-01-01", expiresAt: "2026-12-31" });
      expect(r.success).toBe(false);
    });

    it("allows missing/null dates", () => {
      const r1 = parseCreate({ ...base, startsAt: null, expiresAt: null });
      expect(r1.success).toBe(true);
      const r2 = parseCreate({ ...base, startsAt: "", expiresAt: "" });
      expect(r2.success).toBe(true);
    });
  });

  describe("Bug 4: code max length", () => {
    it("rejects code longer than 50 chars", () => {
      const r = parseCreate({ ...base, code: "A".repeat(VOUCHER_CODE_MAX + 1) });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(firstZodError(r.error)).toMatch(/50 characters/);
      }
    });

    it("accepts code at exactly 50 chars", () => {
      const r = parseCreate({ ...base, code: "A".repeat(VOUCHER_CODE_MAX) });
      expect(r.success).toBe(true);
    });

    it("rejects invalid characters in code", () => {
      const r = parseCreate({ ...base, code: "ABC DEF" });
      expect(r.success).toBe(false);
    });
  });

  describe("Bug 5: HTML in name stripped", () => {
    it("strips script tags from name", () => {
      const r = parseCreate({ ...base, name: "<script>alert('xss')</script>Gift" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.name).toBe("Gift");
    });

    it("strips simple tags from name", () => {
      const r = parseCreate({ ...base, name: "Hello <b>world</b>" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.name).toBe("Hello world");
    });

    it("rejects names that are only HTML tags (become empty after strip)", () => {
      const r = parseCreate({ ...base, name: "<script></script>" });
      expect(r.success).toBe(false);
      if (!r.success) expect(firstZodError(r.error)).toBe("Name is required");
    });
  });

  describe("Bug 6: description max length", () => {
    it("rejects description longer than max", () => {
      const r = parseCreate({ ...base, description: "x".repeat(VOUCHER_DESCRIPTION_MAX + 1) });
      expect(r.success).toBe(false);
      if (!r.success) expect(firstZodError(r.error)).toMatch(/Description/);
    });

    it("accepts description at exactly max length", () => {
      const r = parseCreate({ ...base, description: "x".repeat(VOUCHER_DESCRIPTION_MAX) });
      expect(r.success).toBe(true);
    });

    it("treats blank description as null", () => {
      const r = parseCreate({ ...base, description: "   " });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.description).toBeNull();
    });
  });

  describe("update schema", () => {
    it("validates date range when both supplied", () => {
      const r = updateVoucherSchema.safeParse({ startsAt: "2027-01-01", expiresAt: "2026-01-01" });
      expect(r.success).toBe(false);
    });

    it("allows partial updates", () => {
      const r = updateVoucherSchema.safeParse({ active: false });
      expect(r.success).toBe(true);
    });

    it("rejects whitespace-only name on update", () => {
      const r = updateVoucherSchema.safeParse({ name: "   " });
      expect(r.success).toBe(false);
    });

    it("rejects oversized description on update", () => {
      const r = updateVoucherSchema.safeParse({ description: "x".repeat(VOUCHER_DESCRIPTION_MAX + 1) });
      expect(r.success).toBe(false);
    });
  });
});
