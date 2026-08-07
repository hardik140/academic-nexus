import { View, Text, StyleSheet } from "react-native";
import { colors } from "@/components/ui";

/**
 * Matches the web app's admin/forms page exactly — a confirmed dead stub,
 * not a partial feature. No form definitions/fields/submissions schema
 * exists yet, so there's nothing to port beyond this placeholder.
 */
export default function FormsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>📋</Text>
      <Text style={styles.title}>Coming Soon</Text>
      <Text style={styles.body}>
        The form builder module isn&apos;t wired up yet — it needs a dedicated schema (form definitions, fields,
        submissions) before it can go live.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32, backgroundColor: colors.bg },
  emoji: { fontSize: 40, marginBottom: 16 },
  title: { fontSize: 16, fontWeight: "700", color: colors.text, marginBottom: 8 },
  body: { fontSize: 13, color: colors.textVariant, textAlign: "center", lineHeight: 19 },
});
