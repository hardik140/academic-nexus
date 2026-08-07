import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Platform } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";

const LEAVE_TYPES = [
  { value: "casual", label: "Casual" },
  { value: "sick", label: "Sick" },
  { value: "earned", label: "Earned" },
  { value: "maternity", label: "Maternity" },
  { value: "paternity", label: "Paternity" },
  { value: "study", label: "Study" },
  { value: "sabbatical", label: "Sabbatical" },
  { value: "other", label: "Other" },
];

function toDateString(d: Date) {
  return d.toISOString().split("T")[0];
}

export default function LeaveScreen() {
  const { session } = useAuth();
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [leaveType, setLeaveType] = useState("casual");
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [reason, setReason] = useState("");
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  const load = async () => {
    if (!session?.user.id) return;
    const { data } = await supabase
      .from("leave_requests")
      .select("*")
      .eq("requested_by", session.user.id)
      .order("created_at", { ascending: false });
    setRequests(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [session?.user.id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/leave/apply", {
        leaveType,
        startDate: toDateString(startDate),
        endDate: toDateString(endDate),
        reason,
      });
      setReason("");
      setShowForm(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit leave request.");
    } finally {
      setSubmitting(false);
    }
  };

  const approved = requests.filter((r) => r.status === "approved").length;
  const pending = requests.filter((r) => r.status === "pending").length;
  const rejected = requests.filter((r) => r.status === "rejected").length;

  return (
    <Screen loading={loading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "+ Apply Leave"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Leave request submitted! Awaiting HOD approval.</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      <View style={styles.summaryRow}>
        <Card style={styles.summaryCard}>
          <Text style={[styles.summaryValue, { color: colors.success }]}>✅ {approved}</Text>
          <Text style={styles.summaryLabel}>Approved</Text>
        </Card>
        <Card style={styles.summaryCard}>
          <Text style={[styles.summaryValue, { color: colors.warning }]}>🕐 {pending}</Text>
          <Text style={styles.summaryLabel}>Pending</Text>
        </Card>
        <Card style={styles.summaryCard}>
          <Text style={[styles.summaryValue, { color: colors.error }]}>❌ {rejected}</Text>
          <Text style={styles.summaryLabel}>Rejected</Text>
        </Card>
      </View>

      {showForm && (
        <Card>
          <Text style={styles.formTitle}>📝 New Leave Application</Text>

          <Text style={styles.fieldLabel}>Leave Type *</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {LEAVE_TYPES.map((t) => (
              <Pressable
                key={t.value}
                style={[styles.chip, leaveType === t.value && styles.chipActive]}
                onPress={() => setLeaveType(t.value)}
              >
                <Text style={[styles.chipText, leaveType === t.value && styles.chipTextActive]}>{t.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={styles.fieldLabel}>Start Date *</Text>
          <Pressable style={styles.input} onPress={() => setShowStartPicker(true)}>
            <Text>{startDate.toLocaleDateString()}</Text>
          </Pressable>
          {showStartPicker && (
            <DateTimePicker
              value={startDate}
              mode="date"
              onChange={(_, date) => {
                setShowStartPicker(Platform.OS === "ios");
                if (date) setStartDate(date);
              }}
            />
          )}

          <Text style={styles.fieldLabel}>End Date *</Text>
          <Pressable style={styles.input} onPress={() => setShowEndPicker(true)}>
            <Text>{endDate.toLocaleDateString()}</Text>
          </Pressable>
          {showEndPicker && (
            <DateTimePicker
              value={endDate}
              mode="date"
              onChange={(_, date) => {
                setShowEndPicker(Platform.OS === "ios");
                if (date) setEndDate(date);
              }}
            />
          )}

          <Text style={styles.fieldLabel}>Reason *</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={reason}
            onChangeText={setReason}
            placeholder="Explain the reason for your leave..."
            placeholderTextColor="#9AA0A6"
            multiline
            numberOfLines={3}
          />

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting || !reason}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Submitting..." : "Submit Request"}</Text>
          </Pressable>
        </Card>
      )}

      <Card>
        <Text style={styles.formTitle}>🗓️ Leave History</Text>
        {requests.length > 0 ? (
          requests.map((req: any) => (
            <View key={req.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{req.leave_type.replace(/_/g, " ")} Leave</Text>
                <Text style={styles.rowSub}>
                  🕐 {new Date(req.start_date).toLocaleDateString()} → {new Date(req.end_date).toLocaleDateString()}
                </Text>
                <Text style={styles.rowSub}>{req.reason}</Text>
              </View>
              <StatusBadge status={req.status} />
            </View>
          ))
        ) : (
          <EmptyState>No leave requests submitted.</EmptyState>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  newButton: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  newButtonText: { color: "#fff", fontWeight: "700" },
  successBanner: { backgroundColor: "#1B8A3E15", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#1B8A3E30" },
  successBannerText: { color: colors.success, fontSize: 13, fontWeight: "500" },
  summaryRow: { flexDirection: "row", gap: 12 },
  summaryCard: { flex: 1, alignItems: "center" },
  summaryValue: { fontSize: 18, fontWeight: "800" },
  summaryLabel: { fontSize: 10, fontWeight: "700", color: colors.outline, textTransform: "uppercase", marginTop: 4 },
  formTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 10 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 8, marginBottom: 4 },
  chipRow: { flexDirection: "row", gap: 8, marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, marginRight: 6 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.textVariant },
  chipTextActive: { color: "#fff", fontWeight: "700" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    justifyContent: "center",
  },
  textArea: { minHeight: 70, textAlignVertical: "top" },
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text, textTransform: "capitalize" },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
