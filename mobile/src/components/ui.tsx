import { View, Text, ScrollView, RefreshControl, ActivityIndicator, StyleSheet } from "react-native";
import type { ReactNode } from "react";

export const colors = {
  bg: "#F8F9FF",
  surface: "#FFFFFF",
  surfaceLow: "#EFF4FF",
  border: "#C6C6CD",
  text: "#0B1C30",
  textVariant: "#45464D",
  outline: "#76777D",
  primary: "#0051D5",
  success: "#1B8A3E",
  warning: "#B98600",
  error: "#BA1A1A",
  info: "#0A5FBF",
};

export function Screen({
  children,
  loading,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  loading?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  if (loading) {
    return (
      <View style={styles.centerFill}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.cardTitle}>{children}</Text>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateText}>{children}</Text>
    </View>
  );
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  present: { bg: "#1B8A3E20", fg: colors.success },
  active: { bg: "#1B8A3E20", fg: colors.success },
  paid: { bg: "#1B8A3E20", fg: colors.success },
  cleared: { bg: "#1B8A3E20", fg: colors.success },
  approved: { bg: "#1B8A3E20", fg: colors.success },
  resolved: { bg: "#1B8A3E20", fg: colors.success },
  late: { bg: "#B9860020", fg: colors.warning },
  partial: { bg: "#B9860020", fg: colors.warning },
  pending: { bg: "#B9860020", fg: colors.warning },
  in_progress: { bg: "#B9860020", fg: colors.warning },
  excused: { bg: "#0A5FBF20", fg: colors.info },
  absent: { bg: "#BA1A1A20", fg: colors.error },
  overdue: { bg: "#BA1A1A20", fg: colors.error },
  rejected: { bg: "#BA1A1A20", fg: colors.error },
  expired: { bg: "#BA1A1A20", fg: colors.error },
};

export function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: "#76777D20", fg: colors.outline };
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.fg }]}>{status.replace(/_/g, " ")}</Text>
    </View>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.errorBanner}>
      <Text style={styles.errorBannerText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centerFill: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  cardTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 8 },
  emptyState: { padding: 24, alignItems: "center" },
  emptyStateText: { color: colors.outline, fontSize: 13, textAlign: "center" },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: "flex-start" },
  badgeText: { fontSize: 11, fontWeight: "700", textTransform: "capitalize" },
  errorBanner: { backgroundColor: "#BA1A1A15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#BA1A1A30" },
  errorBannerText: { color: colors.error, fontSize: 13, fontWeight: "500" },
});
