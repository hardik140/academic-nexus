import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import * as Sentry from "@sentry/react-native";
import RootNavigator from "@/navigation/RootNavigator";

const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn),
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function App() {
  return (
    <>
      <RootNavigator />
      <StatusBar style="auto" />
    </>
  );
}

export default Sentry.wrap(App);
