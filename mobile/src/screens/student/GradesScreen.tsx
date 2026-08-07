import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useStudent } from "@/hooks/useStudent";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function GradesScreen() {
  const { student, loading: studentLoading } = useStudent();
  const [marks, setMarks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!student?.id) return;
    const { data } = await supabase
      .from("marks")
      .select("*, courses(name, code, credits)")
      .eq("student_id", student.id)
      .order("semester", { ascending: false });
    setMarks(data || []);
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

  const courseMarks: Record<string, { course: any; exams: any[] }> = {};
  marks.forEach((m: any) => {
    if (!courseMarks[m.course_id]) courseMarks[m.course_id] = { course: m.courses, exams: [] };
    courseMarks[m.course_id].exams.push(m);
  });
  const grouped = Object.values(courseMarks);

  return (
    <Screen loading={loading || studentLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <Card>
        <Text style={styles.cgpaLabel}>Current CGPA</Text>
        <Text style={styles.cgpaValue}>{(student?.cgpa || 0).toFixed(2)}</Text>
        <Text style={styles.cgpaSub}>out of 10.00</Text>
      </Card>

      {grouped.length === 0 && (
        <EmptyState>No exam results available yet. Marks will appear here as they are published.</EmptyState>
      )}

      {grouped.map(({ course, exams }) => (
        <Card key={course?.code}>
          <Text style={styles.courseTitle}>{course?.code} <Text style={styles.courseSub}>{course?.name} • {course?.credits} credits</Text></Text>
          {exams.map((exam: any) => {
            const pct = (exam.obtained_marks / exam.max_marks) * 100;
            const c = pct >= 60 ? colors.success : pct >= 40 ? colors.warning : colors.error;
            return (
              <View key={exam.id} style={styles.examRow}>
                <Text style={styles.examType}>{exam.exam_type.replace(/_/g, " ")}</Text>
                <Text style={styles.examScore}>{exam.obtained_marks}/{exam.max_marks}</Text>
                <Text style={[styles.examPct, { color: c }]}>{pct.toFixed(1)}%</Text>
              </View>
            );
          })}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cgpaLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase" },
  cgpaValue: { fontSize: 32, fontWeight: "800", color: colors.primary, marginTop: 4 },
  cgpaSub: { fontSize: 11, color: colors.outline, marginTop: 2 },
  courseTitle: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 8, textTransform: "capitalize" },
  courseSub: { fontSize: 12, fontWeight: "400", color: colors.outline },
  examRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  examType: { fontSize: 13, color: colors.text, textTransform: "capitalize", flex: 1 },
  examScore: { fontSize: 13, color: colors.textVariant, marginRight: 12 },
  examPct: { fontSize: 13, fontWeight: "800" },
});
