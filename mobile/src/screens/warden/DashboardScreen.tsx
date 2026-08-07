import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { Screen, Card, CardTitle, EmptyState, colors } from "@/components/ui";

export default function DashboardScreen() {
  const { session } = useAuth();
  const [blockCount, setBlockCount] = useState(0);
  const [totalCapacity, setTotalCapacity] = useState(0);
  const [totalOccupancy, setTotalOccupancy] = useState(0);
  const [pendingGatePasses, setPendingGatePasses] = useState<any[]>([]);
  const [openComplaints, setOpenComplaints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!session?.user.id) return;
    const { data: blocks } = await supabase.from("hostel_blocks").select("id").eq("warden_id", session.user.id);
    const blockIds = (blocks || []).map((b) => b.id);
    setBlockCount(blockIds.length);

    const [roomsRes, gatePassesRes, complaintsRes] = await Promise.all([
      blockIds.length ? supabase.from("hostel_rooms").select("capacity, occupancy").in("block_id", blockIds) : Promise.resolve({ data: [] }),
      supabase
        .from("gate_passes")
        .select("*, students:student_id(profiles:user_id(full_name))")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("complaints")
        .select("*")
        .eq("status", "open")
        .in("category", ["hostel", "mess", "plumbing", "electrical", "cleaning"])
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    const rooms = roomsRes.data || [];
    setTotalCapacity(rooms.reduce((s: number, r: any) => s + r.capacity, 0));
    setTotalOccupancy(rooms.reduce((s: number, r: any) => s + r.occupancy, 0));
    setPendingGatePasses(gatePassesRes.data || []);
    setOpenComplaints(complaintsRes.data || []);
    setLoading(false);
  }, [session?.user.id]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const occupancyPct = totalCapacity > 0 ? Math.min((totalOccupancy / totalCapacity) * 100, 100) : 0;

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={styles.greeting}>Warden Dashboard</Text>
      <Text style={styles.subtitle}>Hostel occupancy, gate passes, and maintenance overview</Text>

      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Blocks</Text>
          <Text style={styles.kpiValue}>{blockCount}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Occupancy</Text>
          <Text style={styles.kpiValue}>{totalOccupancy}/{totalCapacity}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${occupancyPct}%` }]} />
          </View>
        </Card>
      </View>
      <View style={styles.kpiRow}>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Pending Passes</Text>
          <Text style={[styles.kpiValue, { color: colors.warning }]}>{pendingGatePasses.length}</Text>
        </Card>
        <Card style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Open Complaints</Text>
          <Text style={[styles.kpiValue, { color: colors.error }]}>{openComplaints.length}</Text>
        </Card>
      </View>

      <Card>
        <CardTitle>Pending Gate Passes</CardTitle>
        {pendingGatePasses.length > 0 ? (
          pendingGatePasses.map((p: any) => (
            <View key={p.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{p.students?.profiles?.full_name || "—"}</Text>
                <Text style={styles.rowSub}>{p.destination} • {new Date(p.exit_time).toLocaleString()}</Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>No pending gate passes.</EmptyState>
        )}
      </Card>

      <Card>
        <CardTitle>Open Complaints</CardTitle>
        {openComplaints.length > 0 ? (
          openComplaints.map((c: any) => (
            <View key={c.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{c.title}</Text>
                <Text style={styles.rowSub}>{c.category} • {c.priority} priority</Text>
              </View>
            </View>
          ))
        ) : (
          <EmptyState>🎉 No open complaints.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  greeting: { fontSize: 20, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 13, color: colors.textVariant, marginBottom: 4 },
  kpiRow: { flexDirection: "row", gap: 12 },
  kpiCard: { flex: 1 },
  kpiLabel: { fontSize: 11, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginBottom: 6 },
  kpiValue: { fontSize: 20, fontWeight: "800", color: colors.text },
  barTrack: { marginTop: 8, height: 6, backgroundColor: colors.surfaceLow, borderRadius: 999, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: colors.primary, borderRadius: 999 },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
