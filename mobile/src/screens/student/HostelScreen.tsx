import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { useStudent } from "@/hooks/useStudent";
import { Screen, Card, colors } from "@/components/ui";
import type { MoreStackParamList } from "@/navigation/StudentTabNavigator";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function HostelScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList>>();
  const { session } = useAuth();
  const { student, loading: studentLoading } = useStudent();
  const [allocation, setAllocation] = useState<any>(null);
  const [menu, setMenu] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!student?.id || !session?.user.id) return;
    const [allocationRes, profileRes] = await Promise.all([
      supabase.from("hostel_allocations").select("*, hostel_rooms(block_name, room_number, type, ac, capacity, occupancy)").eq("student_id", student.id).eq("status", "active").single(),
      supabase.from("profiles").select("college_id").eq("id", session.user.id).single(),
    ]);
    setAllocation(allocationRes.data);
    const todayDay = new Date().getDay();
    const { data: menuData } = await supabase
      .from("mess_menu")
      .select("*")
      .eq("college_id", profileRes.data?.college_id || "")
      .eq("day_of_week", todayDay)
      .order("meal_type");
    const mealOrder = ["breakfast", "lunch", "snacks", "dinner"];
    setMenu((menuData || []).sort((a: any, b: any) => mealOrder.indexOf(a.meal_type) - mealOrder.indexOf(b.meal_type)));
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
      <Card>
        <Text style={styles.title}>🏠 My Room</Text>
        {allocation ? (
          <View style={styles.roomGrid}>
            <View style={styles.roomField}>
              <Text style={styles.fieldLabel}>Block</Text>
              <Text style={styles.fieldValue}>{allocation.hostel_rooms?.block_name}</Text>
            </View>
            <View style={styles.roomField}>
              <Text style={styles.fieldLabel}>Room</Text>
              <Text style={[styles.fieldValue, { color: colors.primary }]}>{allocation.hostel_rooms?.room_number}</Text>
            </View>
            <View style={styles.roomField}>
              <Text style={styles.fieldLabel}>Type</Text>
              <Text style={styles.fieldValueSm}>{allocation.hostel_rooms?.type}</Text>
            </View>
            <View style={styles.roomField}>
              <Text style={styles.fieldLabel}>Occupancy</Text>
              <Text style={styles.fieldValueSm}>{allocation.hostel_rooms?.occupancy}/{allocation.hostel_rooms?.capacity}</Text>
            </View>
          </View>
        ) : (
          <Text style={styles.emptyText}>No hostel room allocated. Contact the warden.</Text>
        )}
      </Card>

      <Card>
        <Text style={styles.title}>🍽️ Today&apos;s Menu — {DAY_NAMES[new Date().getDay()]}</Text>
        {menu.length > 0 ? (
          menu.map((meal: any) => (
            <View key={meal.id} style={styles.mealRow}>
              <Text style={styles.mealType}>{meal.meal_type}{meal.is_vegetarian ? " • Veg" : ""}</Text>
              <Text style={styles.mealItems}>{(meal.items || []).join(" • ")}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>No menu available for today.</Text>
        )}
      </Card>

      <Card>
        <Text style={styles.title}>Quick Links</Text>
        <View style={styles.linksRow}>
          <Pressable style={styles.linkButton} onPress={() => navigation.navigate("GatePass")}>
            <Text style={styles.linkEmoji}>🚪</Text>
            <Text style={styles.linkLabel}>Gate Pass</Text>
          </Pressable>
          <Pressable style={styles.linkButton} onPress={() => navigation.navigate("Complaints", { category: "hostel" })}>
            <Text style={styles.linkEmoji}>🛠️</Text>
            <Text style={styles.linkLabel}>Maintenance</Text>
          </Pressable>
          <Pressable style={styles.linkButton} onPress={() => navigation.navigate("Complaints", { category: "mess" })}>
            <Text style={styles.linkEmoji}>🍽️</Text>
            <Text style={styles.linkLabel}>Mess Feedback</Text>
          </Pressable>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  roomGrid: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  roomField: { width: "45%" },
  fieldLabel: { fontSize: 10, color: colors.outline, textTransform: "uppercase" },
  fieldValue: { fontSize: 16, fontWeight: "800", color: colors.text },
  fieldValueSm: { fontSize: 13, fontWeight: "600", color: colors.text, textTransform: "capitalize" },
  emptyText: { fontSize: 13, color: colors.outline, textAlign: "center", paddingVertical: 12 },
  mealRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#EEE" },
  mealType: { fontSize: 11, fontWeight: "800", color: colors.primary, textTransform: "uppercase" },
  mealItems: { fontSize: 13, color: colors.text, marginTop: 2 },
  linksRow: { flexDirection: "row", gap: 10 },
  linkButton: { flex: 1, alignItems: "center", padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, gap: 6 },
  linkEmoji: { fontSize: 22 },
  linkLabel: { fontSize: 11, fontWeight: "600", color: colors.text, textAlign: "center" },
});
