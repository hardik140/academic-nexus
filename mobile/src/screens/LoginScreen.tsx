import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { signInWithGoogle, signInWithMagicLink } from "@/lib/auth";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const handleGoogle = async () => {
    setLoading(true);
    setMessage(null);
    try {
      await signInWithGoogle();
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Google sign-in failed.", ok: false });
    } finally {
      setLoading(false);
    }
  };

  const handleMagicLink = async () => {
    if (!email.trim()) return;
    setLoading(true);
    setMessage(null);
    try {
      await signInWithMagicLink(email.trim());
      setMessage({ text: "Check your email for the login link!", ok: true });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "Failed to send magic link.", ok: false });
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Academic Nexus</Text>
        <Text style={styles.subtitle}>Enterprise Student Information System</Text>

        <Pressable style={styles.googleButton} onPress={handleGoogle} disabled={loading}>
          <Text style={styles.googleButtonText}>Continue with Google</Text>
        </Pressable>

        <View style={styles.dividerRow}>
          <View style={styles.divider} />
          <Text style={styles.dividerText}>OR</Text>
          <View style={styles.divider} />
        </View>

        <Text style={styles.label}>Institutional Email</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="you@university.edu"
          placeholderTextColor="#9AA0A6"
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!loading}
        />

        <Pressable style={styles.primaryButton} onPress={handleMagicLink} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>Send Magic Link</Text>
          )}
        </Pressable>

        {message && (
          <Text style={[styles.message, message.ok ? styles.messageOk : styles.messageError]}>
            {message.text}
          </Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#F8F9FF" },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    padding: 24,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  title: { fontSize: 28, fontWeight: "800", color: "#0B1C30", textAlign: "center" },
  subtitle: { fontSize: 13, color: "#45464D", textAlign: "center", marginTop: 4, marginBottom: 24 },
  googleButton: {
    borderWidth: 1,
    borderColor: "#C6C6CD",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  googleButtonText: { fontWeight: "600", color: "#0B1C30" },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 20 },
  divider: { flex: 1, height: 1, backgroundColor: "#C6C6CD" },
  dividerText: { marginHorizontal: 12, fontSize: 11, color: "#76777D", fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "600", color: "#45464D", marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: "#C6C6CD",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    color: "#0B1C30",
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: "#0051D5",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: { color: "#fff", fontWeight: "700" },
  message: { marginTop: 16, fontSize: 13, fontWeight: "500", textAlign: "center" },
  messageOk: { color: "#1B8A3E" },
  messageError: { color: "#BA1A1A" },
});
