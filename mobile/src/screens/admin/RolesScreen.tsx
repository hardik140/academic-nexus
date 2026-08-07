import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { supabase } from "@/lib/supabase";
import { Screen, Card, EmptyState, colors } from "@/components/ui";

const ROLES = ["student", "teacher", "hod", "finance", "director", "admin", "warden"];

export default function RolesScreen() {
  const [permissions, setPermissions] = useState<any[]>([]);
  const [rolePermMap, setRolePermMap] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    const [permissionsRes, rolePermsRes] = await Promise.all([
      supabase.from("permissions").select("*").order("module").order("name"),
      supabase.from("role_permissions").select("*"),
    ]);
    setPermissions(permissionsRes.data || []);

    const map: Record<string, Set<string>> = {};
    ROLES.forEach((r) => { map[r] = new Set(); });
    (rolePermsRes.data || []).forEach((rp: any) => {
      if (map[rp.role]) map[rp.role].add(rp.permission_id);
    });
    setRolePermMap(map);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const modules = [...new Set(permissions.map((p: any) => p.module))];

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      {modules.map((mod) => (
        <Card key={mod}>
          <Text style={styles.moduleTitle}>📦 {mod}</Text>
          {permissions.filter((p: any) => p.module === mod).map((p: any) => (
            <View key={p.id} style={styles.permRow}>
              <Text style={styles.permName}>{p.name}</Text>
              {p.description ? <Text style={styles.permDesc}>{p.description}</Text> : null}
              <View style={styles.roleWrap}>
                {ROLES.filter((r) => rolePermMap[r]?.has(p.id)).map((r) => (
                  <View key={r} style={styles.rolePill}>
                    <Text style={styles.rolePillText}>{r}</Text>
                  </View>
                ))}
                {ROLES.filter((r) => !rolePermMap[r]?.has(p.id)).length === ROLES.length && (
                  <Text style={styles.noneText}>No roles granted</Text>
                )}
              </View>
            </View>
          ))}
        </Card>
      ))}
      {permissions.length === 0 && (
        <Card>
          <EmptyState>No permissions configured. Run the seed migration to populate defaults.</EmptyState>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  moduleTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 10, textTransform: "capitalize" },
  permRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  permName: { fontSize: 13, fontWeight: "600", color: colors.text },
  permDesc: { fontSize: 11, color: colors.outline, marginTop: 2 },
  roleWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  rolePill: { backgroundColor: "#1B8A3E15", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  rolePillText: { fontSize: 10, fontWeight: "700", color: colors.success, textTransform: "capitalize" },
  noneText: { fontSize: 11, color: colors.outline, fontStyle: "italic" },
});
