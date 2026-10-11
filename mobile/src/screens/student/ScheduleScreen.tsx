import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useStudent } from "@/hooks/useStudent";
import { Screen, Card, StatusBadge, colors } from "@/components/ui";
import { currentTermEnrolledOfferingIds } from "@/lib/academic";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function ScheduleScreen() {
  const { session } = useAuth();
  // course_enrollments.student_id references students(id) after 047,
  // so this screen needs the student record, not just the session.
  const { student, loading: studentLoading } = useStudent();
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [slots, setSlots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!session?.user.id || !student?.id) return;
    // The student's OWN enrolled offerings in the ACTIVE term — the same rule
    // as the web schedule and the database (055, defect 2). This screen used
    // to list every slot in the college.
    const enrollRes = await supabase
      .from("course_enrollments")
      .select("*, course_offerings:offering_id(id, courses:course_id(id, name, code, credits, type), sections:section_id(name), semesters:semester_id(name, status), profiles:instructor_id(full_name))")
      .eq("student_id", student?.id || "")
      .eq("status", "enrolled");
    const offeringIds = currentTermEnrolledOfferingIds(enrollRes.data as never);
    const slotsRes = offeringIds.length
      ? await supabase
          .from("timetable_slots")
          .select("*, course_offerings:offering_id(id, courses:course_id(name, code), sections:section_id(name))")
          .in("offering_id", offeringIds)
          .order("day_of_week")
          .order("start_time")
      : { data: [] };
    setEnrollments(enrollRes.data || []);
    setSlots(slotsRes.data || []);
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

  const todayIndex = new Date().getDay();
  const grouped: Record<number, any[]> = {};
  slots.forEach((s: any) => {
    if (!grouped[s.day_of_week]) grouped[s.day_of_week] = [];
    grouped[s.day_of_week].push(s);
  });

  return (
    <Screen loading={loading || studentLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <Card>
        <Text style={styles.title}>📅 Weekly Timetable</Text>
        {[1, 2, 3, 4, 5, 6].map((day) => {
          const isToday = day === todayIndex;
          return (
            <View key={day} style={[styles.dayBlock, isToday && styles.dayBlockToday]}>
              <View style={styles.dayHeader}>
                <Text style={[styles.dayName, isToday && { color: colors.primary }]}>{DAY_NAMES[day]}</Text>
                {isToday && <View style={styles.todayPill}><Text style={styles.todayPillText}>TODAY</Text></View>}
              </View>
              {grouped[day]?.length > 0 ? (
                grouped[day].map((slot: any) => (
                  <View key={slot.id} style={styles.slotCard}>
                    <Text style={styles.slotTitle}>
                      {slot.course_offerings?.courses?.code} — {slot.course_offerings?.courses?.name}
                      {slot.course_offerings?.sections?.name ? ` · ${slot.course_offerings.sections.name}` : ""}
                    </Text>
                    <Text style={styles.slotTime}>
                      🕐 {slot.start_time?.slice(0, 5)} – {slot.end_time?.slice(0, 5)}{slot.room ? ` • 📍 Room ${slot.room}` : ""}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={styles.noClasses}>No classes scheduled</Text>
              )}
            </View>
          );
        })}
      </Card>

      <Card>
        <Text style={styles.title}>📚 Enrolled Courses</Text>
        {enrollments.length > 0 ? (
          enrollments.map((e: any) => (
            <View key={e.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>
                  {e.course_offerings?.courses?.code} — {e.course_offerings?.courses?.name}
                  {e.course_offerings?.sections?.name ? ` · ${e.course_offerings.sections.name}` : ""}
                </Text>
                <Text style={styles.rowSub}>
                  {e.course_offerings?.courses?.credits} credits • {e.course_offerings?.profiles?.full_name || "TBA"}
                </Text>
              </View>
              <StatusBadge status={e.status} />
            </View>
          ))
        ) : (
          <Text style={styles.noClasses}>No courses enrolled yet.</Text>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  dayBlock: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  dayBlockToday: { backgroundColor: "#0051D508" },
  dayHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  dayName: { fontSize: 11, fontWeight: "800", color: colors.textVariant, textTransform: "uppercase" },
  todayPill: { backgroundColor: colors.primary, paddingHorizontal: 6, borderRadius: 999 },
  todayPillText: { fontSize: 9, fontWeight: "800", color: "#fff" },
  slotCard: { backgroundColor: colors.surfaceLow, borderRadius: 10, padding: 10, marginBottom: 6 },
  slotTitle: { fontSize: 13, fontWeight: "600", color: colors.text },
  slotTime: { fontSize: 11, color: colors.outline, marginTop: 2 },
  noClasses: { fontSize: 12, color: colors.outline, fontStyle: "italic" },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
