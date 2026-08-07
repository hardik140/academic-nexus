import { NextResponse } from "next/server";
import { RbacError } from "@/lib/rbac";
import { updateCollegeViaRequest } from "@/app/(portal)/admin/settings/actions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await updateCollegeViaRequest(request, {
      name: body.name,
      code: body.code,
      domain: body.domain,
      accreditation: body.accreditation,
      established_year: body.established_year,
      email: body.email,
      phone: body.phone,
      website: body.website,
      address: body.address,
      city: body.city,
      state: body.state,
      country: body.country,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof RbacError) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : err.code === "INACTIVE" ? 403 : 403;
      return NextResponse.json({ error: err.message }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Request failed." }, { status: 400 });
  }
}
