import { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, ErrorBanner, colors } from "@/components/ui";


const STATUS_CYCLE = ["present", "absent", "late", "excused"];
const STATUS_COLORS: Record<string, string> = {
  present: colors.success,
  absent: colors.error,
  late: colors.warning,
  excused: colors.info,
};

function toDateString(d: Date) {
  return d.toISOString().split("T")[0];
}

export default function AttendanceScreen() {
  const { session } = useAuth();
  const [offerings, setOfferings] = useState<any[]>([]);
  const [selectedOffering, setSelectedOffering] = useState("");
  const [students, setStudents] = useState<any[]>([]);
  const [attendance, setAttendance] = useState<Record<string, string>>({});
  const [date, setDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.user.id) return;
    // Offerings, not courses — the register belongs to a section in a
    // semester, which courses.instructor_id could never identify.
    supabase
      .from("course_offerings")
      .select("id, status, courses:course_id(id, name, code), sections:section_id(name), semesters:semester_id(name)")
      .eq("instructor_id", session.user.id)
      .then(({ data }) => {
        setOfferings(((data as any[]) || []).filter((o) => o.status !== "cancelled"));
        setLoading(false);
      });
  }, [session?.user.id]);

  const loadStudents = async (offeringId: string) => {
    setSelectedOffering(offeringId);
    const dateStr = toDateString(date);
    // Keyed by students.id throughout: course_enrollments.student_id
    // references students(id) after 047, so the map written here and the
    // map read at save time are finally the same id space.
    const { data: enrollments } = await supabase
      .from("course_enrollments")
      .select("student_id, students:student_id(id, enrollment_number, profiles:user_id(full_name, email))")
      .eq("offering_id", offeringId)
      .eq("status", "enrolled");

    const studentList = ((enrollments as any[]) || []).map((e) => ({
      id: e.student_id,
      full_name: e.students?.profiles?.full_name || "Unknown",
      email: e.students?.profiles?.email || "",
    }));
    setStudents(studentList);

    const { data: existing } = await supabase
      .from("attendance")
      .select("student_id, status")
      .eq("offering_id", offeringId)
      .eq("date", dateStr);

    const att: Record<string, string> = {};
    ((existing as any[]) || []).forEach((a) => { att[a.student_id] = a.status; });
    studentList.forEach((s) => { if (!att[s.id]) att[s.id] = "present"; });
    setAttendance(att);
  };

  const toggleStatus = (studentId: string) => {
    const current = attendance[studentId] || "present";
    const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(current) + 1) % STATUS_CYCLE.length];
    setAttendance({ ...attendance, [studentId]: next });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // No students lookup needed any more — the map is already keyed by
      // students.id, which is what the API expects.
      const entries = students.map((s: any) => ({
        studentDbId: s.id,
        status: attendance[s.id] || "present",
      }));

      await apiPost("/api/mobile/attendance/save", {
        offeringId: selectedOffering,
        date: toDateString(date),
        entries,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save attendance.");
    } finally {
      setSaving(false);
    }
  };

  const counts = {
    present: Object.values(attendance).filter((v) => v === "present").length,
    absent: Object.values(attendance).filter((v) => v === "absent").length,
    late: Object.values(attendance).filter((v) => v === "late").length,
  };

  return (
    <Screen loading={loading}>
      {saved && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Attendance saved successfully for {toDateString(date)}!</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      <Card>
        <Text style={styles.fieldLabel}>Course</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
          {offerings.map((o) => (
            <Pressable
              key={o.id}
              style={[styles.chip, selectedOffering === o.id && styles.chipActive]}
              onPress={() => loadStudents(o.id)}
            >
              <Text style={[styles.chipText, selectedOffering === o.id && styles.chipTextActive]}>
                {o.courses?.code}{o.sections?.name ? ` · ${o.sections.name}` : ""}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={styles.fieldLabel}>Date</Text>
        <Pressable style={styles.input} onPress={() => setShowDatePicker(true)}>
          <Text>{date.toLocaleDateString()}</Text>
        </Pressable>
        {showDatePicker && (
          <DateTimePicker
            value={date}
            mode="date"
            onChange={(_, d) => {
              setShowDatePicker(Platform.OS === "ios");
              if (d) {
                setDate(d);
                if (selectedOffering) loadStudents(selectedOffering);
              }
            }}
          />
        )}
      </Card>

      {selectedOffering && students.length > 0 && (
        <>
          <View style={styles.summaryRow}>
            <Card style={styles.summaryCard}>
              <Text style={[styles.summaryValue, { color: colors.success }]}>{counts.present}</Text>
              <Text style={styles.summaryLabel}>Present</Text>
            </Card>
            <Card style={styles.summaryCard}>
              <Text style={[styles.summaryValue, { color: colors.error }]}>{counts.absent}</Text>
              <Text style={styles.summaryLabel}>Absent</Text>
            </Card>
            <Card style={styles.summaryCard}>
              <Text style={[styles.summaryValue, { color: colors.warning }]}>{counts.late}</Text>
              <Text style={styles.summaryLabel}>Late</Text>
            </Card>
          </View>

          <Card>
            <Text style={styles.fieldLabel}>Tap a student&apos;s status to cycle it</Text>
            {students.map((s: any, i: number) => (
              <Pressable key={s.id} style={styles.studentRow} onPress={() => toggleStatus(s.id)}>
                <Text style={styles.studentIndex}>{i + 1}.</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.studentName}>{s.full_name}</Text>
                  <Text style={styles.studentEmail}>{s.email}</Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: `${STATUS_COLORS[attendance[s.id] || "present"]}20` }]}>
                  <Text style={[styles.statusPillText, { color: STATUS_COLORS[attendance[s.id] || "present"] }]}>
                    {attendance[s.id] || "present"}
                  </Text>
                </View>
              </Pressable>
            ))}
          </Card>

          <Pressable style={[styles.saveButton, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
            <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Attendance"}</Text>
          </Pressable>
        </>
      )}

      {selectedOffering && students.length === 0 && (
        <Card>
          <EmptyState>No students enrolled in this course.</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  successBanner: { backgroundColor: "#1B8A3E15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1B8A3E30" },
  successBannerText: { color: colors.success, fontSize: 13, fontWeight: "500" },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 4, marginBottom: 6 },
  chipRow: { flexDirection: "row", marginBottom: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textVariant },
  chipTextActive: { color: "#fff" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  summaryRow: { flexDirection: "row", gap: 12 },
  summaryCard: { flex: 1, alignItems: "center" },
  summaryValue: { fontSize: 22, fontWeight: "800" },
  summaryLabel: { fontSize: 10, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginTop: 4 },
  studentRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE", gap: 8 },
  studentIndex: { fontSize: 12, color: colors.outline, width: 20, textAlign: "right" },
  studentName: { fontSize: 14, fontWeight: "600", color: colors.text },
  studentEmail: { fontSize: 11, color: colors.outline, marginTop: 1 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, minWidth: 72, alignItems: "center" },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  saveButton: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  saveButtonText: { color: "#fff", fontWeight: "700" },
});
