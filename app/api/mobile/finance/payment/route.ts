import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { recordPaymentViaRequest } from "@/app/(portal)/finance/transactions/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await recordPaymentViaRequest(request, {
      feeId: body.feeId,
      amount: body.amount,
      method: body.method,
      transactionRef: body.transactionRef,
      notes: body.notes,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
