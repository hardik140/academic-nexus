import { useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import { colors } from "@/components/ui";
import { revokeSession, signOutEverywhere, type Admission, type DeviceSession } from "@/lib/session";
import { formatDate } from "@/lib/format";

/** An instant in India Standard Time (owner decision D7). */
const formatDateTime = (value: string) =>
  formatDate(value, { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Why the app cannot be used right now (migrations 053/054) — never a
 * generic "authentication failed". Mirrors the web /unavailable page.
 */
export default function AccessScreen({ admission, onRetry }: { admission: Exclude<Admission, { state: "active" }>; onRetry: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy("signout");
    await signOutEverywhere();
  };

  const revoke = async (session: DeviceSession) => {
    setBusy(session.session_id);
    setError(null);
    try {
      await revokeSession(session.session_id);
      onRetry();
    } catch {
      setError("That device couldn't be signed out. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  let title = "We couldn't verify your access";
  let body = "Your access could not be checked just now. Nothing has changed; please try again in a moment.";
  let sessions: DeviceSession[] = [];
  let retry = true;

  switch (admission.state) {
    case "college_unavailable":
      if (admission.collegeState === "MAINTENANCE") {
        title = "Under maintenance";
        body = `${admission.collegeName ?? "Your college"} is temporarily unavailable while maintenance is carried out. Your data is safe and nothing has been changed.`;
      } else {
        title = "Access suspended";
        body = `Access to ${admission.collegeName ?? "your college"} is currently suspended. Your data has not been deleted. Please contact your college administration.`;
        retry = false;
      }
      break;
    case "rejected":
      title = "Too many active devices";
      body = `Your account is already signed in on ${admission.maxSessions === 1 ? "the one device" : `${admission.maxSessions ?? "the maximum number of"} devices`} it is allowed. To use this phone, sign out of one of them first.`;
      sessions = admission.sessions.filter((s) => !s.is_current && s.status === "active");
      break;
    case "revoked":
      title = "You have been signed out";
      body = "This session was signed out — from another device, by an administrator, or because your college's status changed. Sign in again to continue.";
      retry = false;
      break;
    case "inactive":
      title = "Account not active";
      body = "Your account is not active. Please contact your college administration.";
      retry = false;
      break;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      <Text style={styles.body}>{body}</Text>

      {admission.state === "college_unavailable" && admission.message ? (
        <View style={styles.note}>
          <Text style={styles.noteTitle}>Message from the administrator</Text>
          <Text style={styles.body}>{admission.message}</Text>
        </View>
      ) : null}
      {admission.state === "college_unavailable" && admission.expectedResumeAt ? (
        <Text style={styles.body}>Expected to be back by {formatDateTime(admission.expectedResumeAt)} (IST).</Text>
      ) : null}

      {sessions.map((s) => (
        <View key={s.session_id} style={styles.device}>
          <View style={{ flex: 1 }}>
            <Text style={styles.deviceName}>{s.device_label || (s.client === "web" ? "Web browser" : "Mobile app")}</Text>
            <Text style={styles.deviceMeta}>Last active {formatDateTime(s.last_seen_at)}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sign out ${s.device_label || "that device"}`}
            style={styles.secondaryButton}
            onPress={() => revoke(s)}
            disabled={!!busy}
          >
            {busy === s.session_id ? <ActivityIndicator /> : <Text style={styles.secondaryText}>Sign out</Text>}
          </Pressable>
        </View>
      ))}

      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}

      {retry ? (
        <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={onRetry} disabled={!!busy}>
          <Text style={styles.primaryText}>Try again</Text>
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={signOut} disabled={busy === "signout"}>
        <Text style={styles.secondaryText}>{admission.state === "revoked" ? "Sign in again" : "Sign out"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 12, backgroundColor: colors.bg },
  title: { fontSize: 22, fontWeight: "800", color: colors.text },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  note: { backgroundColor: colors.surfaceLow, borderRadius: 12, padding: 12, gap: 4 },
  noteTitle: { fontSize: 13, fontWeight: "700", color: colors.textVariant },
  device: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: 12, padding: 12 },
  deviceName: { fontSize: 15, fontWeight: "600", color: colors.text },
  deviceMeta: { fontSize: 12, color: colors.textVariant },
  error: { color: colors.error, fontSize: 14 },
  primaryButton: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", minHeight: 44 },
  primaryText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
  secondaryButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center", minHeight: 44 },
  secondaryText: { color: colors.text, fontWeight: "600", fontSize: 15 },
});
