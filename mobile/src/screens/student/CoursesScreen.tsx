import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useStudent } from "@/hooks/useStudent";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function CoursesScreen() {
  const { session } = useAuth();
  // course_enrollments.student_id references students(id) after 047,
  // so this screen needs the student record, not just the session.
  const { student, loading: studentLoading } = useStudent();
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!session?.user.id || !student?.id) return;
    const { data } = await supabase
      .from("course_enrollments")
      // Enrollment names an offering, and the instructor is the person
      // teaching THIS section — not whoever owns the catalog row.
      .select("*, course_offerings:offering_id(id, courses:course_id(id, name, code, credits, type), sections:section_id(name), semesters:semester_id(name), profiles:instructor_id(full_name))")
      // students(id): course_enrollments.student_id was repointed by 047,
      // so comparing it to the profile id matched nothing.
      .eq("student_id", student?.id || "")
      .order("status");
    setEnrollments(data || []);
    setLoading(false);
  };

  useEffect(() => {
    if (!studentLoading) load();
  }, [studentLoading, student?.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen loading={loading || studentLoading} refreshing={refreshing} onRefresh={onRefresh}>
      {enrollments.length === 0 && (
        <EmptyState>No course enrollments found. Contact your department admin.</EmptyState>
      )}
      {enrollments.map((e: any) => {
        const offering = e.course_offerings;
        const course = offering?.courses;
        return (
          <Card key={e.id}>
            <View style={styles.headerRow}>
              <Text style={styles.code}>{course?.code}</Text>
              <View style={styles.statusPill}>
                <Text style={styles.statusPillText}>{e.status}</Text>
              </View>
            </View>
            <Text style={styles.name}>{course?.name}</Text>
            <Text style={styles.meta}>
              👥 {offering?.sections?.name ? `Section ${offering.sections.name}` : "Section —"} • {offering?.semesters?.name || "—"}
            </Text>
            <Text style={styles.meta}>📚 {course?.credits} credits • {course?.type}</Text>
            {/* The instructor of THIS section, from the offering — not
                whoever happens to own the catalog row. */}
            <Text style={styles.meta}>👨‍🏫 {offering?.profiles?.full_name || "TBA"}</Text>
            {e.grade && (
              <View style={styles.gradeRow}>
                <Text style={styles.gradeLabel}>Final Grade</Text>
                <Text style={styles.gradeValue}>{e.grade}</Text>
              </View>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  code: { fontSize: 12, fontWeight: "800", color: colors.primary, textTransform: "uppercase" },
  statusPill: { backgroundColor: "#1B8A3E20", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 10, fontWeight: "700", color: colors.success, textTransform: "capitalize" },
  name: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 6 },
  meta: { fontSize: 12, color: colors.outline, marginBottom: 2 },
  gradeRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  gradeLabel: { fontSize: 12, color: colors.outline },
  gradeValue: { fontSize: 14, fontWeight: "800", color: colors.primary },
});
