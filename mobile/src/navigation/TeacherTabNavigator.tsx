import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Text } from "react-native";

import DashboardScreen from "@/screens/teacher/DashboardScreen";
import CoursesScreen from "@/screens/teacher/CoursesScreen";
import AttendanceScreen from "@/screens/teacher/AttendanceScreen";
import GradingScreen from "@/screens/teacher/GradingScreen";
import MoreScreen from "@/screens/teacher/MoreScreen";
import TimetableScreen from "@/screens/teacher/TimetableScreen";
import LeaveScreen from "@/screens/teacher/LeaveScreen";

export type TeacherMoreStackParamList = {
  MoreMenu: undefined;
  Timetable: undefined;
  Leave: undefined;
};

const Tab = createBottomTabNavigator();
const MoreStack = createNativeStackNavigator<TeacherMoreStackParamList>();

const TAB_ICONS: Record<string, string> = {
  Dashboard: "📊",
  Courses: "📚",
  Attendance: "✅",
  Grading: "📝",
  More: "☰",
};

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICONS[label]}</Text>;
}

function MoreStackNavigator() {
  return (
    <MoreStack.Navigator>
      <MoreStack.Screen name="MoreMenu" component={MoreScreen} options={{ title: "More" }} />
      <MoreStack.Screen name="Timetable" component={TimetableScreen} options={{ title: "Timetable" }} />
      <MoreStack.Screen name="Leave" component={LeaveScreen} options={{ title: "Leave" }} />
    </MoreStack.Navigator>
  );
}

export default function TeacherTabNavigator() {
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
      <Tab.Screen name="Grading" component={GradingScreen} />
      <Tab.Screen name="More" component={MoreStackNavigator} options={{ headerShown: false }} />
    </Tab.Navigator>
  );
}
