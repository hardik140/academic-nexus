// Academic Nexus - System Store & Data Models
const ERP_DATA = {
  currentUser: {
    name: "Alex Mercer",
    role: "student",
    id: "STU-2024-8841",
    department: "Computer Science",
    avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuDH24n1lXig2CpYlm3-7cBRTv3NvCkXKGMWU2nNAFEd5X6Oo8MS985FHAENgN6P0inPgp9nMRXuAAkckwxNvwb0nEtFue-HHdM5nsjiJxmF43ZGNVTtWqFCoYRbGalz53kqlZIAI0xijqRcirYTKWM6vZgHSP0hy3frvUgp4ygP8kcEA4kK0wqNcQnEWJk2c9IS9W9aisqurLO4Wjg4qCauCpYhiVH9rgUPWjEeIG1xhoFNoIeXG-s8j4ezqy1RCFo5lGKPoN_usy0"
  },
  roles: [
    { id: "student", name: "Student", label: "My Academic Hub", icon: "dashboard", avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuDH24n1lXig2CpYlm3-7cBRTv3NvCkXKGMWU2nNAFEd5X6Oo8MS985FHAENgN6P0inPgp9nMRXuAAkckwxNvwb0nEtFue-HHdM5nsjiJxmF43ZGNVTtWqFCoYRbGalz53kqlZIAI0xijqRcirYTKWM6vZgHSP0hy3frvUgp4ygP8kcEA4kK0wqNcQnEWJk2c9IS9W9aisqurLO4Wjg4qCauCpYhiVH9rgUPWjEeIG1xhoFNoIeXG-s8j4ezqy1RCFo5lGKPoN_usy0", userName: "Alex Mercer" },
    { id: "admin", name: "System Admin", label: "Admin Console", icon: "admin_panel_settings", avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuBNFzWao94hZRDvvuE_3mS76Gfk4DPTOUdSgEPt4EfMix53v4VuqtaI-J_w3t5jrX0yaW7kdtPcoRezPnRc9Fm_w3t3APHQaOWyZAAiTwJY8GnF-ekDznNzyV_Iukf0ZSnQ1UQcPeMN4NafH-K_8Lf-ymfdX7B3bGtMDk1_jh-Q-n6ON9BvMIilRsafLksk-kI5M8hVEilWaAFV2M5eijx4NOzCfg_xzKAXA7fWxGaLKqRXnO3_gncXne_hWb1q-pLrS7vvxWex3x0", userName: "Dr. Arthur Smith" },
    { id: "director", name: "Director", label: "Director's 360 View", icon: "leaderboard", avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuAqiGxmGC-YrgucsYwCyQ8TfqEO_yJENdDbPHxgAmihZtO6LdoHNcXPFmrf18gvPOvRfj5bU1s1PCeNh76DEY6an6bewI6Lk4E5903oBgI_OUcSeGTz9GfQiMGZyukZUYux3AySOSjStIx5z2ZHm0h1CJQ80eRsYErBFwR1BaYsVuyIDq1jWCSnzDRcxv65ykviyIRr6HoN3mT5bQI6uncuX3bOf2xa4dV4I_FJH2n99rV6N6dcGBGp1Qdr2Y0LWoNe3DBq8D8avyU", userName: "Prof. Richard Sterling" },
    { id: "finance", name: "Finance Manager", label: "Billing & Accounts", icon: "account_balance", avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuDzNRtm9mCHTXHQkqu3WaQTbwCVvR8cPwPFmMMLTi8-tH3QZfZmTIrZYZuRAGrZ4c2OThYRvODr4Q5SRhw-i4Lop-wJ8NiSiCbBSO1tkLETz5Xd5SkI5I3HwJ5AfK8LwX9JiOPZ9XSFr3G_WOpqw5MWdv2GOpGDKpCNZHQQxSDp7V2F1jyQ9YgMNcnD28etChMx8tMRSQKZL9qpzzg1u0_0Awx9fFM-SqFUyQgsyPobEYVE6gHiXlvNIltbZL_UxyFLLohXI4xSCT8", userName: "Elena Vance" },
    { id: "hod", name: "HOD", label: "Departmental Control", icon: "psychology", avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuCfbcwO-o_tIvWuCI17faEL-kIeHeu3VWQHxK0e1qvzlq9tv-gbGUwhkkVYZF0-c1xf-lganRBjSHFmser2G5tZd4G4PqGY90FLiPbqqBzlXbCXCc80SjPxjmzL6eBFyLJHezw5ZA6FeYYtLiVCf1PisZD_EVV60W-wADFRkd-MTJqD5jaJar64J7HmyU8cCEuc1UqJfnYqLrPzfAizMaMEm8QrImjXF_J9fp2HiK2pgaz23p-4t5N0HonXrkQKGZei4PV0bqCwE6U", userName: "Dr. Alan Turing" },
    { id: "warden", name: "Hostel Warden", label: "Warden Operations", icon: "apartment", avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuBaD8gkEJbz-AYWh9huApKjctRZK-xejxmdWUMV6ZqzReQ54iL1UBJFVivRKnho5Y9M6cILAm5IdrwNln0A7mmhG2JlI4YokPZehdjXx1Iqr6ycKSxTGW3NPpwU11UEsdCYB8ty3TQExYTQoD4Oyayjq4Km3eRu1h7x_Rzvkb645M-kqVzy93DNuoeXbu0C1o6SnPVMtEITdgCcSuzQMRnxhG90ZYLGPYlaJ5oxf5Ely1NY5rVAczL-geU0kjKwqtQusA0y8TH0sGY", userName: "Warden H. Vance" },
    { id: "teacher", name: "Faculty / Teacher", label: "Classroom & Sync", icon: "school", avatar: "https://lh3.googleusercontent.com/aida-public/AB6AXuBLAGcgMiw3eHCwNNZkyt7Oo2qubLbsL88nS7yEoKdxy07Xn9C3YBDu8SaqcmcPy5bGDCWeQeyYfTzugG8TB9f24ZTKznmcKh8xXNMGQNBaxZf9BvqKgiKwc2BGoCRtrniNwcj28zQ1aKTB3Md4a_qeIfCtuE0Y3m9rzqRLyoH_sYWLiyGgmvuEAQ0Ea--06QMcWOjkgO83x-yxz4VJQZ8Vg0iQH1JL16XCpgPd__bG34HU8C-NytxlwjEI0o-FHQXiE-cSrCa9KGU", userName: "Prof. M. Curie" }
  ],
  schedule: [
    { time: "08:00 AM", name: "AP Calculus (CS-301)", room: "Sci-302", instructor: "Dr. H. Euler", status: "Present", badge: "badge-success", icon: "check_circle" },
    { time: "10:30 AM", name: "Physics II (PHY-202)", room: "Lab-1B", instructor: "Prof. M. Curie", status: "Upcoming", badge: "badge-info", icon: "schedule" },
    { time: "01:15 PM", name: "World Literature", room: "Hum-105", instructor: "V. Woolf", status: "Scheduled", badge: "badge-warning", icon: "schedule" }
  ],
  transactions: [
    { id: "TX-9021", date: "Oct 24, 09:15 AM", student: "Sarah Jenkins", sid: "48921", type: "Tuition Payment", amount: "+$4,500.00", status: "CLEARED", badge: "badge-success" },
    { id: "TX-9020", date: "Oct 24, 08:30 AM", student: "Merit Fund A", sid: "DISBURSED", type: "Scholarship Applied", amount: "+$1,200.00", status: "CLEARED", badge: "badge-success" },
    { id: "TX-9019", date: "Oct 23, 02:45 PM", student: "Marcus Thorne", sid: "33912", type: "Hostel Deposit", amount: "+$300.00", status: "CLEARED", badge: "badge-success" },
    { id: "TX-9018", date: "Oct 23, 11:20 AM", student: "Elena Rostova", sid: "99102", type: "Mess Billing", amount: "+$185.00", status: "PENDING", badge: "badge-warning" }
  ],
  gatePasses: [
    { id: "GP-104", student: "Alex Mercer", room: "Block B-402", destination: "City Center", exit: "Oct 24, 17:00", return: "Oct 24, 21:00", status: "APPROVED", warden: "H. Vance" },
    { id: "GP-105", student: "Sarah Jenkins", room: "Block A-201", destination: "Home Visit", exit: "Oct 25, 09:00", return: "Oct 27, 18:00", status: "PENDING", warden: "Unassigned" },
    { id: "GP-106", student: "David Miller", room: "Block C-108", destination: "Hospital Visit", exit: "Oct 24, 14:00", return: "Oct 24, 18:00", status: "ACTIVE", warden: "H. Vance" }
  ],
  auditLogs: [
    { time: "10:42 AM Today", user: "H. Warden (Hostel)", roleBadge: "HW", action: "Updated room allotment for 'Boys Hostel Block B'" },
    { time: "09:15 AM Today", user: "System", roleBadge: "SYS", action: "Auto-sync failure: Hostel Gate Biometrics (Attempt 3)", alert: true },
    { time: "Yesterday 4:30 PM", user: "A. Smith (Admin)", roleBadge: "AS", action: "Created 45 new student profiles (Batch Import)" },
    { time: "Yesterday 2:10 PM", user: "A. Smith (Admin)", roleBadge: "AS", action: "Updated global grading policy 'Term 2'" }
  ],
  announcements: [
    { title: "Parent-Teacher Conferences", body: "Scheduling is now open for Fall conferences. Please book your slots by Friday.", time: "2 hours ago", category: "Academic" },
    { title: "Varsity Sports Tryouts", body: "Basketball and Soccer tryouts begin next Monday at the main athletic complex.", time: "1 day ago", category: "Campus Life" },
    { title: "Q3 STEM Research Grants Released", body: "Faculty proposals approved. Funds credited to departmental budgets.", time: "2 days ago", category: "Finance" }
  ],
  notifications: [
    { title: "Fee Due Reminder", desc: "Outstanding tuition balance of $1,250 due on Nov 15, 2024.", unread: true },
    { title: "Gate Pass Approved", desc: "Your gate pass for City Center (GP-104) has been approved by Warden.", unread: true },
    { title: "Grade Posted", desc: "Midterm Essay grade posted: 92% (A) in World Literature.", unread: false }
  ]
};
