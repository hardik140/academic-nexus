import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { colors } from "@/components/ui";

export interface StudentOption {
  id: string;
  label: string;
}

/** Searchable student picker — RN has no native <select>, and a chip row
 * doesn't scale to 80+ students the way it does for a handful of exam types.
 * Shared across portals (Finance, Director) that need to attach a mutation
 * to an arbitrary student. */
export function StudentPicker({
  students,
  value,
  onChange,
}: {
  students: StudentOption[];
  value: string;
  onChange: (studentId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = students.find((s) => s.id === value);

  if (selected && !search) {
    return (
      <Pressable style={styles.selectedRow} onPress={() => setSearch(" ")}>
        <Text style={styles.selectedText}>{selected.label}</Text>
        <Text style={styles.changeText}>Change</Text>
      </Pressable>
    );
  }

  const filtered = students.filter((s) => s.label.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 15);

  return (
    <View>
      <TextInput
        style={styles.input}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name or enrollment number..."
        placeholderTextColor="#9AA0A6"
      />
      <View style={styles.list}>
        {filtered.map((s) => (
          <Pressable
            key={s.id}
            style={styles.row}
            onPress={() => {
              onChange(s.id);
              setSearch("");
            }}
          >
            <Text style={styles.rowText}>{s.label}</Text>
          </Pressable>
        ))}
        {filtered.length === 0 && <Text style={styles.empty}>No students match.</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text },
  list: { maxHeight: 180, borderWidth: 1, borderColor: colors.border, borderRadius: 10, marginTop: 6, overflow: "hidden" },
  row: { paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#EEE" },
  rowText: { fontSize: 13, color: colors.text },
  empty: { padding: 12, fontSize: 12, color: colors.outline, textAlign: "center" },
  selectedRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  selectedText: { fontSize: 14, color: colors.text, fontWeight: "600", flex: 1 },
  changeText: { fontSize: 12, color: colors.primary, fontWeight: "700" },
});
