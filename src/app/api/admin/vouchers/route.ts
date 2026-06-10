import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import {
  getAllVouchers,
  getVoucherWithRedemptions,
  getVoucherStats,
  createVoucher,
  updateVoucher,
  deleteVoucher,
} from "@/lib/voucher";
import {
  createVoucherSchema,
  updateVoucherSchema,
  firstZodError,
} from "@/lib/voucher/validation";

function safeErrorMessage(error: unknown, fallback: string): string {
  // Never leak raw Prisma error messages — they expose internal column/constraint names.
  const prismaCode = (error as { code?: string } | null)?.code;
  if (prismaCode === "P2002") return "A voucher with that code already exists";
  if (prismaCode === "P2000") return "One of the fields is too long for the database";
  if (prismaCode && /^P\d+$/.test(prismaCode)) return fallback;
  if (error instanceof Error) return error.message;
  return fallback;
}

// GET - Get all vouchers and stats
export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const voucherId = url.searchParams.get("id");

  try {
    if (voucherId) {
      // Get single voucher with redemptions
      const voucher = await getVoucherWithRedemptions(voucherId);
      if (!voucher) {
        return NextResponse.json({ error: "Voucher not found" }, { status: 404 });
      }
      return NextResponse.json({ voucher });
    }

    // Get all vouchers and stats
    const [vouchers, stats] = await Promise.all([
      getAllVouchers(),
      getVoucherStats(),
    ]);

    return NextResponse.json({
      vouchers,
      stats,
    });
  } catch (error) {
    console.error("Failed to get voucher data:", error);
    return NextResponse.json(
      { error: "Failed to get voucher data" },
      { status: 500 }
    );
  }
}

// POST - Create a new voucher
export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = createVoucherSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: firstZodError(parsed.error) },
        { status: 400 }
      );
    }

    const voucher = await createVoucher({
      ...parsed.data,
      description: parsed.data.description ?? undefined,
      minTopupCents: parsed.data.minTopupCents ?? undefined,
      maxRedemptions: parsed.data.maxRedemptions ?? undefined,
      startsAt: parsed.data.startsAt ?? undefined,
      expiresAt: parsed.data.expiresAt ?? undefined,
      createdBy: session.email,
    });

    console.log(`Admin ${session.email} created voucher ${voucher.code}`);

    return NextResponse.json({
      success: true,
      voucher,
    });
  } catch (error) {
    console.error("Failed to create voucher:", error);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create voucher") },
      { status: 500 }
    );
  }
}

// PATCH - Update a voucher
export async function PATCH(request: NextRequest) {
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { id, ...rest } = body ?? {};

    if (!id || typeof id !== "string") {
      return NextResponse.json(
        { error: "Voucher ID is required" },
        { status: 400 }
      );
    }

    const parsed = updateVoucherSchema.safeParse(rest);
    if (!parsed.success) {
      return NextResponse.json(
        { error: firstZodError(parsed.error) },
        { status: 400 }
      );
    }

    const voucher = await updateVoucher(id, parsed.data);

    console.log(`Admin ${session.email} updated voucher ${voucher.code}`);

    return NextResponse.json({
      success: true,
      voucher,
    });
  } catch (error) {
    console.error("Failed to update voucher:", error);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update voucher") },
      { status: 500 }
    );
  }
}

// DELETE - Delete a voucher
export async function DELETE(request: NextRequest) {
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { error: "Voucher ID is required" },
      { status: 400 }
    );
  }

  try {
    await deleteVoucher(id);

    console.log(`Admin ${session.email} deleted voucher ${id}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete voucher:", error);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete voucher") },
      { status: 500 }
    );
  }
}
