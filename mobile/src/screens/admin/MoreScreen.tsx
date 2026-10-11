import { View, Text, Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { signOutEverywhere } from "@/lib/session";
import { colors } from "@/components/ui";
import type { AdminMoreStackParamList } from "@/navigation/AdminTabNavigator";

const ITEMS: { label: string; icon: string; screen: keyof AdminMoreStackParamList }[] = [
  { label: "Roles & Permissions", icon: "🔐", screen: "Roles" },
  { label: "Hostel Blocks", icon: "🏠", screen: "Hostel" },
  { label: "Web Forms", icon: "📋", screen: "Forms" },
  { label: "Audit Log", icon: "📜", screen: "Audit" },
  { label: "Settings", icon: "⚙️", screen: "Settings" },
];

export default function MoreScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AdminMoreStackParamList>>();

  return (
    <View style={styles.container}>
      {ITEMS.map((item) => (
        <Pressable key={item.screen} style={styles.row} onPress={() => navigation.navigate(item.screen as any)}>
          <Text style={styles.icon}>{item.icon}</Text>
          <Text style={styles.label}>{item.label}</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      ))}

      <Pressable style={[styles.row, styles.signOutRow]} onPress={() => signOutEverywhere()}>
        <Text style={styles.icon}>🚪</Text>
        <Text style={[styles.label, { color: colors.error }]}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#EEE",
    gap: 12,
  },
  icon: { fontSize: 18 },
  label: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.text },
  chevron: { fontSize: 18, color: colors.outline },
  signOutRow: { marginTop: 24 },
});
