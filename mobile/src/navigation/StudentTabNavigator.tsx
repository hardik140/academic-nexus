import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Text } from "react-native";

import DashboardScreen from "@/screens/student/DashboardScreen";
import CoursesScreen from "@/screens/student/CoursesScreen";
import AttendanceScreen from "@/screens/student/AttendanceScreen";
import FeesScreen from "@/screens/student/FeesScreen";
import MoreScreen from "@/screens/student/MoreScreen";
import ScheduleScreen from "@/screens/student/ScheduleScreen";
import GradesScreen from "@/screens/student/GradesScreen";
import HostelScreen from "@/screens/student/HostelScreen";
import GatePassScreen from "@/screens/student/GatePassScreen";
import ComplaintsScreen from "@/screens/student/ComplaintsScreen";

export type MoreStackParamList = {
  MoreMenu: undefined;
  Schedule: undefined;
  Grades: undefined;
  Hostel: undefined;
  GatePass: undefined;
  Complaints: { category?: string } | undefined;
};

const Tab = createBottomTabNavigator();
const MoreStack = createNativeStackNavigator<MoreStackParamList>();

const TAB_ICONS: Record<string, string> = {
  Dashboard: "📊",
  Courses: "📚",
  Attendance: "✅",
  Fees: "💰",
  More: "☰",
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label]}</Text>;
}

function MoreStackNavigator() {
  return (
    <MoreStack.Navigator>
      <MoreStack.Screen name="MoreMenu" component={MoreScreen} options={{ title: "More" }} />
      <MoreStack.Screen name="Schedule" component={ScheduleScreen} options={{ title: "Schedule" }} />
      <MoreStack.Screen name="Grades" component={GradesScreen} options={{ title: "Grades" }} />
      <MoreStack.Screen name="Hostel" component={HostelScreen} options={{ title: "Hostel" }} />
      <MoreStack.Screen name="GatePass" component={GatePassScreen} options={{ title: "Gate Pass" }} />
      <MoreStack.Screen name="Complaints" component={ComplaintsScreen} options={{ title: "Complaints" }} />
    </MoreStack.Navigator>
  );
}

export default function StudentTabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused }) => <TabIcon label={route.name} focused={focused} />,
        tabBarActiveTintColor: "#0051D5",
        headerTitleStyle: { fontWeight: "700" },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Courses" component={CoursesScreen} />
      <Tab.Screen name="Attendance" component={AttendanceScreen} />
      <Tab.Screen name="Fees" component={FeesScreen} />
      <Tab.Screen name="More" component={MoreStackNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}
