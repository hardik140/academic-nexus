import { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function RoomsScreen() {
  const { session } = useAuth();
  const [rooms, setRooms] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    if (!session?.user.id) return;
    const { data: blocks } = await supabase.from("hostel_blocks").select("id").eq("warden_id", session.user.id);
    const blockIds = (blocks || []).map((b) => b.id);
    if (blockIds.length === 0) {
      setRooms([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("hostel_rooms")
      .select("*")
      .in("block_id", blockIds)
      .order("block_name")
      .order("room_number");
    setRooms(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [session?.user.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = rooms.filter(
    (r: any) => !search || r.room_number?.toLowerCase().includes(search.toLowerCase()) || r.block_name?.toLowerCase().includes(search.toLowerCase())
  );

  const statusColor = (status: string) =>
    status === "available" ? colors.success : status === "full" ? colors.warning : colors.error;

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by block or room #..."
        placeholderTextColor="#9AA0A6"
      />

      {filtered.map((r: any) => (
        <Card key={r.id}>
          <View style={styles.headerRow}>
            <Text style={styles.roomTitle}>{r.block_name} — Room {r.room_number}</Text>
            <View style={[styles.statusPill, { backgroundColor: `${statusColor(r.status)}20` }]}>
              <Text style={[styles.statusPillText, { color: statusColor(r.status) }]}>{r.status}</Text>
            </View>
          </View>
          <Text style={styles.meta}>🏷️ {r.type} {r.ac ? "• ❄️ AC" : ""}</Text>
          <Text style={[styles.meta, r.occupancy >= r.capacity && { color: colors.error, fontWeight: "700" }]}>
            👥 {r.occupancy}/{r.capacity} occupied
          </Text>
        </Card>
      ))}
      {filtered.length === 0 && (
        <Card>
          <EmptyState>{rooms.length === 0 ? "No rooms found for your managed blocks." : "No rooms match your search."}</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  roomTitle: { fontSize: 14, fontWeight: "700", color: colors.text, flex: 1 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  meta: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
