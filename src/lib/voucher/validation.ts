import { z } from "zod";

// DB columns are VARCHAR(191); keep input limits below that.
export const VOUCHER_CODE_MAX = 50;
export const VOUCHER_NAME_MAX = 100;
export const VOUCHER_DESCRIPTION_MAX = 190;

// Admins enter calendar dates via <input type="date"> ("YYYY-MM-DD"). Restrict to
// a sane range so typos like "0001" or "9999" can't make it past validation.
export const VOUCHER_DATE_MIN = "2020-01-01";
export const VOUCHER_DATE_MAX = "2099-12-31";

const stripHtmlTags = (s: string) =>
  s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "");

const codeField = z
  .string({ error: "Code is required" })
  .transform((s) => s.trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(1, "Code is required")
      .max(VOUCHER_CODE_MAX, `Code must be ${VOUCHER_CODE_MAX} characters or fewer`)
      .regex(/^[A-Z0-9_-]+$/, "Code may only contain letters, numbers, hyphens, and underscores"),
  );

const nameField = z
  .string({ error: "Name is required" })
  .transform((s) => stripHtmlTags(s).trim())
  .pipe(
    z
      .string()
      .min(1, "Name is required")
      .max(VOUCHER_NAME_MAX, `Name must be ${VOUCHER_NAME_MAX} characters or fewer`),
  );

const descriptionField = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((s) => (s == null ? null : s.trim()))
  .pipe(
    z
      .string()
      .max(VOUCHER_DESCRIPTION_MAX, `Description must be ${VOUCHER_DESCRIPTION_MAX} characters or fewer`)
      .nullable(),
  )
  .transform((s) => (s === "" ? null : s));

const dateField = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((s) => (s == null || s === "" ? null : s))
  .pipe(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be a valid calendar date")
      .refine((v) => v >= VOUCHER_DATE_MIN && v <= VOUCHER_DATE_MAX, {
        message: `Date must be between ${VOUCHER_DATE_MIN} and ${VOUCHER_DATE_MAX}`,
      })
      .refine((v) => !Number.isNaN(new Date(v).getTime()), {
        message: "Date must be a valid calendar date",
      })
      .nullable(),
  );

// Voucher.creditCents / minTopupCents are MySQL INT columns.
const MAX_CENTS = 2_147_483_647;

const creditCentsField = z
  .number({ error: "Credit amount is required" })
  .int("Credit amount must be a whole number of cents")
  .positive("Credit amount must be greater than zero")
  .max(MAX_CENTS, `Credit amount too large (max $${(MAX_CENTS / 100).toLocaleString()})`);

const minTopupField = z
  .union([z.number(), z.null(), z.undefined()])
  .transform((v) => (v == null ? null : v))
  .pipe(
    z
      .number()
      .int("Min top-up must be a whole number of cents")
      .nonnegative("Min top-up cannot be negative")
      .max(MAX_CENTS, `Min top-up too large (max $${(MAX_CENTS / 100).toLocaleString()})`)
      .nullable(),
  );

const maxRedemptionsField = z
  .union([z.number(), z.null(), z.undefined()])
  .transform((v) => (v == null ? null : v))
  .pipe(z.number().int().positive("Max redemptions must be positive").nullable());

const maxPerCustomerField = z
  .union([z.number(), z.undefined()])
  .transform((v) => (v == null ? 1 : v))
  .pipe(z.number().int().positive("Max per customer must be positive"));

export const createVoucherSchema = z
  .object({
    code: codeField,
    name: nameField,
    description: descriptionField,
    creditCents: creditCentsField,
    minTopupCents: minTopupField,
    maxRedemptions: maxRedemptionsField,
    maxPerCustomer: maxPerCustomerField,
    startsAt: dateField,
    expiresAt: dateField,
    active: z.boolean().optional().default(true),
  })
  .refine(
    (v) => !(v.startsAt && v.expiresAt) || v.startsAt <= v.expiresAt,
    { message: "Starts At must be on or before Expires At", path: ["expiresAt"] },
  );

export const updateVoucherSchema = z
  .object({
    name: nameField.optional(),
    description: descriptionField.optional(),
    creditCents: creditCentsField.optional(),
    minTopupCents: minTopupField.optional(),
    maxRedemptions: maxRedemptionsField.optional(),
    maxPerCustomer: maxPerCustomerField.optional(),
    startsAt: dateField.optional(),
    expiresAt: dateField.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (v) => !(v.startsAt && v.expiresAt) || v.startsAt <= v.expiresAt,
    { message: "Starts At must be on or before Expires At", path: ["expiresAt"] },
  );

export type CreateVoucherInputParsed = z.infer<typeof createVoucherSchema>;
export type UpdateVoucherInputParsed = z.infer<typeof updateVoucherSchema>;

export function firstZodError(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Invalid input";
}
