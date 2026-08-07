import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { Screen, Card, colors } from "@/components/ui";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function TimetableScreen() {
  const { session } = useAuth();
  const [slots, setSlots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!session?.user.id) return;
    const { data: profile } = await supabase.from("profiles").select("college_id").eq("id", session.user.id).single();
    const { data } = await supabase
      .from("timetable_slots")
      .select("*, courses(name, code)")
      .eq("college_id", profile?.college_id || "")
      .eq("instructor_id", session.user.id)
      .order("day_of_week")
      .order("start_time");
    setSlots(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [session?.user.id]);

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
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Card>
        <Text style={styles.title}>📅 My Timetable</Text>
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
                    <Text style={styles.slotTitle}>📚 {slot.courses?.code} — {slot.courses?.name}</Text>
                    <Text style={styles.slotTime}>
                      🕐 {slot.start_time?.slice(0, 5)} – {slot.end_time?.slice(0, 5)}{slot.room ? ` • 📍 Room ${slot.room}` : ""}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={styles.noClasses}>✅ Free — no classes scheduled</Text>
              )}
            </View>
          );
        })}
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
});
