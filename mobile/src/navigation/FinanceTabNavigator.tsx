import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Text } from "react-native";

import DashboardScreen from "@/screens/finance/DashboardScreen";
import InvoicesScreen from "@/screens/finance/InvoicesScreen";
import TransactionsScreen from "@/screens/finance/TransactionsScreen";
import ScholarshipsScreen from "@/screens/finance/ScholarshipsScreen";
import ReportsScreen from "@/screens/finance/ReportsScreen";

const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, string> = {
  Dashboard: "📊",
  Transactions: "💳",
  Invoices: "🧾",
  Scholarships: "🎓",
  Reports: "📈",
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label]}</Text>;
}

export default function FinanceTabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
        tabBarActiveTintColor: "#0051D5",
        headerTitleStyle: { fontWeight: "700" },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Transactions" component={TransactionsScreen} />
      <Tab.Screen name="Invoices" component={InvoicesScreen} />
      <Tab.Screen name="Scholarships" component={ScholarshipsScreen} />
      <Tab.Screen name="Reports" component={ReportsScreen} />
    </Tab.Navigator>
  );
}
