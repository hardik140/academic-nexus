"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal, Button, FormField } from "@/components/ui/modal";
import { Alert } from "@/components/ui/alert";
import { ErrorAlert } from "@/components/ui/error-alert";
import { StateView } from "@/components/ui/state-view";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { toFeedbackError, type FeedbackError } from "@/lib/action-failure";
import { SessionExpiredError } from "@/lib/feedback-error";
import { requireData } from "@/lib/read-result";
import { updateCollege } from "./actions";

const EMPTY_FORM = {
  name: "", code: "", domain: "", accreditation: "", established_year: "",
  email: "", phone: "", website: "", address: "", city: "", state: "", country: "",
};

export default function AdminSettings() {
  const supabase = createClient();
  const [showEdit, setShowEdit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FeedbackError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  // The institution's record. A failed load is an error, never a profile of dashes (D5).
  const collegeResource = useAsyncResource(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new SessionExpiredError();
    const profile = requireData(await supabase.from("profiles").select("college_id").eq("id", user.id).single());
    if (!profile) return null;
    return requireData(await supabase.from("colleges").select("*").eq("id", profile.college_id).single());
  }, []);
  const college: any = collegeResource.data ?? null;

  const openEdit = () => {
    if (college) {
      setForm({
        name: college.name || "",
        code: college.code || "",
        domain: college.domain || "",
        accreditation: college.accreditation || "",
        established_year: college.established_year ? String(college.established_year) : "",
        email: college.email || "",
        phone: college.phone || "",
        website: college.website || "",
        address: college.address || "",
        city: college.city || "",
        state: college.state || "",
        country: college.country || "",
      });
    }
    setError(null);
    setShowEdit(true);
  };

  const handleSave = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      await updateCollege({
        name: form.name,
        code: form.code,
        domain: form.domain,
        accreditation: form.accreditation,
        established_year: form.established_year ? Number(form.established_year) : undefined,
        email: form.email,
        phone: form.phone,
        website: form.website,
        address: form.address,
        city: form.city,
        state: form.state,
        country: form.country,
      });
      setShowEdit(false);
      setNotice("Institution settings saved.");
      collegeResource.reload();
    } catch (e) {
      setError(await toFeedbackError(e, "Failed to update settings."));
    } finally {
      setLoading(false);
    }
  };

  const fields: Array<[string, string | number | null | undefined]> = college ? [
    ["Institution Name", college.name],
    ["Code", college.code],
    ["Domain", college.domain],
    ["Accreditation", college.accreditation],
    ["Established", college.established_year],
    ["Email", college.email],
    ["Phone", college.phone],
    ["Website", college.website],
    ["Address", college.address],
    ["City", college.city],
    ["State", college.state],
    ["Country", college.country],
  ] : [];

  return (
    <div className="space-y-lg">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Settings</h1>
          <p className="text-sm text-on-surface-variant mt-xs">Institution profile and configuration</p>
        </div>
        <Button onClick={openEdit} disabled={!college}>Edit</Button>
      </div>

      <Alert tone="success" onDismiss={() => setNotice(null)}>
        {notice}
      </Alert>
      {/* The edit dialog shows its own failure. */}
      <ErrorAlert error={!showEdit ? error : null} />

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Institution Profile</h2>
        </div>
        <StateView state={collegeResource} loadingLabel="Loading the institution profile…" empty={{ title: "No institution profile found" }}>
          {() => (
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 divide-outline-variant">
          {fields.map(([label, value]) => (
            <div key={label} className="px-lg py-md border-b md:border-b-0 border-outline-variant">
              <div className="text-xs font-semibold text-outline uppercase tracking-wider mb-xs">{label}</div>
              <div className="text-sm text-on-surface">{value || "—"}</div>
            </div>
          ))}
        </div>
          )}
        </StateView>
      </div>

      <Modal
        open={showEdit}
        onClose={() => setShowEdit(false)}
        title="Edit Institution Settings"
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowEdit(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={loading || !form.name || !form.code} aria-busy={loading || undefined}>{loading ? "Saving..." : "Save Changes"}</Button>
          </>
        }
      >
        <ErrorAlert error={error} className="mb-md" />
        <div className="space-y-lg">
          <div>
            <h3 className="text-xs font-bold text-outline uppercase tracking-wider mb-sm">General Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
              <FormField label="Institution Name" id="s_name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
              <FormField label="Code" id="s_code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />
              <FormField label="Domain" id="s_domain" value={form.domain} onChange={(v) => setForm({ ...form, domain: v })} placeholder="college.edu" />
              <FormField label="Accreditation" id="s_accreditation" value={form.accreditation} onChange={(v) => setForm({ ...form, accreditation: v })} />
              <FormField label="Established Year" id="s_established" type="number" value={form.established_year} onChange={(v) => setForm({ ...form, established_year: v })} />
            </div>
          </div>
          <div>
            <h3 className="text-xs font-bold text-outline uppercase tracking-wider mb-sm">Contact Details</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
              <FormField label="Email" id="s_email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
              <FormField label="Phone" id="s_phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
              <FormField label="Website" id="s_website" value={form.website} onChange={(v) => setForm({ ...form, website: v })} />
            </div>
          </div>
          <div>
            <h3 className="text-xs font-bold text-outline uppercase tracking-wider mb-sm">Location</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div className="md:col-span-2">
                <FormField label="Address" id="s_address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
              </div>
              <FormField label="City" id="s_city" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
              <FormField label="State" id="s_state" value={form.state} onChange={(v) => setForm({ ...form, state: v })} />
              <FormField label="Country" id="s_country" value={form.country} onChange={(v) => setForm({ ...form, country: v })} />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
