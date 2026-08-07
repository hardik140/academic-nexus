import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Text } from "react-native";

import DashboardScreen from "@/screens/director/DashboardScreen";
import AnalyticsScreen from "@/screens/director/AnalyticsScreen";
import DepartmentsScreen from "@/screens/director/DepartmentsScreen";
import FacultyScreen from "@/screens/director/FacultyScreen";
import PlacementsScreen from "@/screens/director/PlacementsScreen";

const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, string> = {
  Dashboard: "📊",
  Analytics: "📈",
  Departments: "🏢",
  Faculty: "👥",
  Placements: "💼",
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label]}</Text>;
}

export default function DirectorTabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
        tabBarActiveTintColor: "#0051D5",
        headerTitleStyle: { fontWeight: "700" },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Analytics" component={AnalyticsScreen} />
      <Tab.Screen name="Departments" component={DepartmentsScreen} />
      <Tab.Screen name="Faculty" component={FacultyScreen} />
      <Tab.Screen name="Placements" component={PlacementsScreen} />
    </Tab.Navigator>
  );
}
