import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-errors";
import { createInvoiceViaRequest } from "@/app/(portal)/finance/invoices/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await createInvoiceViaRequest(request, {
      studentId: body.studentId,
      type: body.type,
      amount: body.amount,
      dueDate: body.dueDate,
      academicYear: body.academicYear,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
