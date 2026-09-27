import type { Tables } from "@/types/database";

// Fictional profile for the development-only portal-shell harness
// (app/dev/shell). Not a real account; nothing is fetched.
export const SAMPLE_PROFILE: Tables<"profiles"> = {
  id: "00000000-0000-4000-8000-000000000001",
  college_id: "00000000-0000-4000-8000-000000000002",
  full_name: "Kavita Deshmukh",
  email: "director@example.edu",
  avatar_url: null,
  phone: null,
  role: "director",
  department_id: null,
  status: "active",
  date_of_birth: null,
  gender: null,
  address: null,
  city: null,
  state: null,
  pincode: null,
  emergency_contact_name: null,
  emergency_contact_phone: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};
