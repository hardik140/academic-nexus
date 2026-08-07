import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { supabase } from "@/lib/supabase";
import { useStudent } from "@/hooks/useStudent";
import { apiPost } from "@/lib/api";
import { Screen, Card, EmptyState, StatusBadge, ErrorBanner, colors } from "@/components/ui";

export default function GatePassScreen() {
  const { student, loading: studentLoading } = useStudent();
  const [passes, setPasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [destination, setDestination] = useState("");
  const [reason, setReason] = useState("");
  const [exitTime, setExitTime] = useState<Date>(new Date());
  const [returnTime, setReturnTime] = useState<Date>(new Date(Date.now() + 24 * 3600 * 1000));
  const [showExitPicker, setShowExitPicker] = useState(false);
  const [showReturnPicker, setShowReturnPicker] = useState(false);

  const load = async () => {
    if (!student?.id) return;
    const { data } = await supabase.from("gate_passes").select("*").eq("student_id", student.id).order("created_at", { ascending: false });
    setPasses(data || []);
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

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost("/api/mobile/gatepass/apply", {
        destination,
        reason,
        exitTime: exitTime.toISOString(),
        returnTime: returnTime.toISOString(),
      });
      setDestination("");
      setReason("");
      setShowForm(false);
      setSuccess(true);
      await load();
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit gate pass request.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen loading={loading || studentLoading} refreshing={refreshing} onRefresh={onRefresh}>
      <Pressable style={styles.newButton} onPress={() => setShowForm(!showForm)}>
        <Text style={styles.newButtonText}>{showForm ? "Cancel" : "+ New Request"}</Text>
      </Pressable>

      {success && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>✅ Gate pass request submitted! Awaiting warden approval.</Text>
        </View>
      )}
      {error && <ErrorBanner message={error} />}

      {showForm && (
        <Card>
          <Text style={styles.formTitle}>📝 New Gate Pass Application</Text>
          <Text style={styles.fieldLabel}>Destination *</Text>
          <TextInput style={styles.input} value={destination} onChangeText={setDestination} placeholder="e.g. Home, Hospital" placeholderTextColor="#9AA0A6" />
          <Text style={styles.fieldLabel}>Reason</Text>
          <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="Reason for leaving campus" placeholderTextColor="#9AA0A6" />

          <Text style={styles.fieldLabel}>Exit Date &amp; Time *</Text>
          <Pressable style={styles.input} onPress={() => setShowExitPicker(true)}>
            <Text>{exitTime.toLocaleString()}</Text>
          </Pressable>
          {showExitPicker && (
            <DateTimePicker
              value={exitTime}
              mode="datetime"
              onChange={(_, date) => {
                setShowExitPicker(Platform.OS === "ios");
                if (date) setExitTime(date);
              }}
            />
          )}

          <Text style={styles.fieldLabel}>Expected Return *</Text>
          <Pressable style={styles.input} onPress={() => setShowReturnPicker(true)}>
            <Text>{returnTime.toLocaleString()}</Text>
          </Pressable>
          {showReturnPicker && (
            <DateTimePicker
              value={returnTime}
              mode="datetime"
              onChange={(_, date) => {
                setShowReturnPicker(Platform.OS === "ios");
                if (date) setReturnTime(date);
              }}
            />
          )}

          <Pressable
            style={[styles.submitButton, submitting && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={submitting || !destination}
          >
            <Text style={styles.submitButtonText}>{submitting ? "Submitting..." : "Submit Application"}</Text>
          </Pressable>
        </Card>
      )}

      <Card>
        <Text style={styles.formTitle}>🚪 My Gate Passes</Text>
        {passes.length > 0 ? (
          passes.map((pass: any) => (
            <View key={pass.id} style={styles.rowItem}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{pass.destination}</Text>
                <Text style={styles.rowSub}>
                  🕐 {new Date(pass.exit_time).toLocaleString()} → {new Date(pass.return_time).toLocaleString()}
                </Text>
                {pass.reason ? <Text style={styles.rowSub}>{pass.reason}</Text> : null}
              </View>
              <StatusBadge status={pass.status} />
            </View>
          ))
        ) : (
          <EmptyState>No gate pass requests found.</EmptyState>
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
  formTitle: { fontSize: 13, fontWeight: "700", color: colors.text, marginBottom: 10 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textVariant, marginTop: 8, marginBottom: 4 },
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
  submitButton: { marginTop: 16, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  submitButtonText: { color: "#fff", fontWeight: "700" },
  rowItem: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  rowSub: { fontSize: 12, color: colors.outline, marginTop: 2 },
});
