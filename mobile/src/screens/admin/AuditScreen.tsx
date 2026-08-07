import { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

export default function AuditScreen() {
  const [logs, setLogs] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const { data } = await supabase
      .from("audit_logs")
      .select("*, profiles:user_id(full_name, email, role)")
      .order("created_at", { ascending: false })
      .limit(100);
    setLogs(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = logs.filter(
    (l: any) => !search || l.action?.toLowerCase().includes(search.toLowerCase()) || l.profiles?.full_name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <TextInput style={styles.search} value={search} onChangeText={setSearch} placeholder="Search by user or action..." placeholderTextColor="#9AA0A6" />

      <Card>
        <Text style={styles.title}>System Activity ({filtered.length})</Text>
        {filtered.length > 0 ? (
          filtered.map((log: any) => (
            <View key={log.id} style={styles.row}>
              <View style={styles.headerRow}>
                <Text style={styles.action}>{log.action}</Text>
                <Text style={styles.timestamp}>{new Date(log.created_at).toLocaleString()}</Text>
              </View>
              <Text style={styles.meta}>
                {log.profiles?.full_name || "System"} • {log.profiles?.role || "system"} • {log.table_name}
              </Text>
            </View>
          ))
        ) : (
          <EmptyState>No audit log entries recorded yet.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  title: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  row: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  action: { fontSize: 13, fontWeight: "600", color: colors.text, flex: 1 },
  timestamp: { fontSize: 10, color: colors.outline },
  meta: { fontSize: 11, color: colors.outline, marginTop: 2, textTransform: "capitalize" },
});
