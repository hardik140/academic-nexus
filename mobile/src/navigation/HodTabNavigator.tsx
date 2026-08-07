import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Text } from "react-native";

import DashboardScreen from "@/screens/hod/DashboardScreen";
import ApprovalsScreen from "@/screens/hod/ApprovalsScreen";
import FacultyScreen from "@/screens/hod/FacultyScreen";
import CoursesScreen from "@/screens/hod/CoursesScreen";
import ReportsScreen from "@/screens/hod/ReportsScreen";

const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, string> = {
  Dashboard: "📊",
  Approvals: "✅",
  Faculty: "👥",
  Courses: "📚",
  Reports: "📈",
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label]}</Text>;
}

export default function HodTabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
        tabBarActiveTintColor: "#0051D5",
        headerTitleStyle: { fontWeight: "700" },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Approvals" component={ApprovalsScreen} />
      <Tab.Screen name="Faculty" component={FacultyScreen} />
      <Tab.Screen name="Courses" component={CoursesScreen} />
      <Tab.Screen name="Reports" component={ReportsScreen} />
    </Tab.Navigator>
  );
}
