import { useEffect } from "react";
import { View, ActivityIndicator, Text } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { useAuth } from "@/hooks/useAuth";
import { handleAuthRedirect } from "@/lib/auth";
import LoginScreen from "@/screens/LoginScreen";
import StudentTabNavigator from "@/navigation/StudentTabNavigator";
import TeacherTabNavigator from "@/navigation/TeacherTabNavigator";
import HodTabNavigator from "@/navigation/HodTabNavigator";
import WardenTabNavigator from "@/navigation/WardenTabNavigator";
import FinanceTabNavigator from "@/navigation/FinanceTabNavigator";
import DirectorTabNavigator from "@/navigation/DirectorTabNavigator";
import AdminTabNavigator from "@/navigation/AdminTabNavigator";
import { useProfile } from "@/hooks/useProfile";
import { usePushRegistration } from "@/hooks/usePushRegistration";

export default function RootNavigator() {
  const { session, loading: authLoading } = useAuth();

  useEffect(() => {
    // Cold-start deep link (app opened directly from the auth email link).
    Linking.getInitialURL().then((url) => {
      if (url) handleAuthRedirect(url);
    });
    // Warm-start deep link (app already running in the background).
    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleAuthRedirect(url);
    });
    return () => subscription.remove();
  }, []);

  if (authLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color="#0051D5" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      {session ? <AuthenticatedRoot /> : <LoginScreen />}
    </NavigationContainer>
  );
}

function AuthenticatedRoot() {
  const { profile, loading } = useProfile();
  usePushRegistration(!loading && !!profile);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color="#0051D5" />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
        <Text>No profile found for this account yet. Try signing out and back in.</Text>
      </View>
    );
  }

  switch (profile.role) {
    case "student":
      return <StudentTabNavigator />;
    case "teacher":
      return <TeacherTabNavigator />;
    case "hod":
      return <HodTabNavigator />;
    case "warden":
      return <WardenTabNavigator />;
    case "finance":
      return <FinanceTabNavigator />;
    case "director":
      return <DirectorTabNavigator />;
    case "admin":
      return <AdminTabNavigator />;
    default:
      // All 7 roles are built for mobile now — this only fires for a
      // stale/unexpected profiles.role value at runtime.
      return (
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
          <Text>Unrecognized role &apos;{profile.role}&apos;. Contact your administrator.</Text>
        </View>
      );
  }
}
