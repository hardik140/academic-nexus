import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Text } from "react-native";

import DashboardScreen from "@/screens/admin/DashboardScreen";
import UsersScreen from "@/screens/admin/UsersScreen";
import DepartmentsScreen from "@/screens/admin/DepartmentsScreen";
import CoursesScreen from "@/screens/admin/CoursesScreen";
import MoreScreen from "@/screens/admin/MoreScreen";
import RolesScreen from "@/screens/admin/RolesScreen";
import HostelScreen from "@/screens/admin/HostelScreen";
import FormsScreen from "@/screens/admin/FormsScreen";
import AuditScreen from "@/screens/admin/AuditScreen";
import SettingsScreen from "@/screens/admin/SettingsScreen";

export type AdminMoreStackParamList = {
  MoreMenu: undefined;
  Roles: undefined;
  Hostel: undefined;
  Forms: undefined;
  Audit: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator();
const MoreStack = createNativeStackNavigator<AdminMoreStackParamList>();

const TAB_ICONS: Record<string, string> = {
  Dashboard: "📊",
  Users: "👥",
  Departments: "🏢",
  Courses: "📚",
  More: "☰",
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label]}</Text>;
}

function MoreStackNavigator() {
  return (
    <MoreStack.Navigator>
      <MoreStack.Screen name="MoreMenu" component={MoreScreen} options={{ title: "More" }} />
      <MoreStack.Screen name="Roles" component={RolesScreen} options={{ title: "Roles & Permissions" }} />
      <MoreStack.Screen name="Hostel" component={HostelScreen} options={{ title: "Hostel Blocks" }} />
      <MoreStack.Screen name="Forms" component={FormsScreen} options={{ title: "Web Forms" }} />
      <MoreStack.Screen name="Audit" component={AuditScreen} options={{ title: "Audit Log" }} />
      <MoreStack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
    </MoreStack.Navigator>
  );
}

export default function AdminTabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
        tabBarActiveTintColor: "#0051D5",
        headerTitleStyle: { fontWeight: "700" },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Users" component={UsersScreen} />
      <Tab.Screen name="Departments" component={DepartmentsScreen} />
      <Tab.Screen name="Courses" component={CoursesScreen} />
      <Tab.Screen name="More" component={MoreStackNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}
