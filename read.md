# Academic Nexus — Student Information System (SIS) & College ERP Ecosystem

Welcome to **Academic Nexus**, an enterprise-grade, multi-portal Student Information System & College ERP web application built according to the Google Stitch design specifications, powered by a **Node.js Express REST API backend**.

---

## 🚀 How to Run the Project & REST API Server

### 1. Starting the Express REST API Backend
Open your terminal in `d:\collage erp` and run:
```bash
node server.js
```
*or*
```bash
npm start
```
The REST API server will start listening on **`http://localhost:3000`**.

### 2. Opening the Frontend
Open [`index.html`](file:///d:/collage%20erp/index.html) directly in any web browser or serve it via any static file server. The frontend automatically connects to `http://localhost:3000/api` for real-time REST API state management, with built-in offline fallback!

---

## 📡 REST API Endpoint Documentation

| HTTP Method | Endpoint Route | Description |
| :--- | :--- | :--- |
| **GET** | `/api/health` | System infrastructure health & uptime metrics |
| **GET** | `/api/roles` | List of all 7 institutional portal roles |
| **GET** | `/api/user/profile` | Current active user profile info |
| **GET** | `/api/schedule` | Timetable & class schedule |
| **GET** | `/api/transactions` | Financial transactions & fee receivables |
| **POST** | `/api/transactions` | Record a new fee payment / create invoice |
| **GET** | `/api/gatepasses` | Fetch out-of-campus gate passes |
| **POST** | `/api/gatepasses` | Request a new gate pass |
| **PATCH** | `/api/gatepasses/:id` | Approve / update gate pass clearance |
| **GET** | `/api/auditlogs` | Real-time audit trail logs |
| **GET** | `/api/announcements` | Portal announcements & alerts |
| **POST** | `/api/announcements` | Broadcast a new campus announcement |
| **POST** | `/api/users` | Onboard a new institutional user profile |

---

## 🌟 Portals & Institutional Roles Included

1. 🎓 **Student Dashboard (`My Academic Hub`)**:
   - Academic Progress, Cumulative GPA (3.84), Credit progress bar (85/120).
   - Class timetable with live attendance status chips (Present, Upcoming, Scheduled).
   - Outstanding fee alert & direct payment modal integration connected to REST API.
   - Hostel block/room info, daily mess menu breakdown, recent grade feedback, and announcements.

2. ⚙️ **Super Admin Console (`Institutional Control`)**:
   - Core system health monitoring (99.98% Uptime, 124ms response latency, API sync status).
   - Real-time audit trail log with severity indicators.
   - User management metrics and onboarding modal workflows.
   - Global database sync and role permission configuration.

3. 📊 **Director's 360 View (`Institutional View`)**:
   - High-level executive KPIs (Total Enrollment 12,450, Revenue vs Target $42.1M, Pass Rate 88.4%, Compliance Score 94%, Hostel Occupancy 92%).
   - Campus emergency alerts feed and broadcast announcement creation modal.
   - Departmental performance leaderboard (Computer Science, Arts & Humanities, Mechanical Engineering).

4. 💳 **Finance & Hostel Billing (`Billing & Accounts`)**:
   - Term receivables overview ($4.25M collected out of $6.25M target).
   - Aged accounts receivable tracking (Tuition Dues, Room Rent Dues, 90+ Days Overdue).
   - Action modals for creating invoices, recording payments, and scholarship disbursements.
   - Detailed financial transactions table with cleared/pending status badges.

5. 🧠 **HOD Departmental Control (`HOD Portal`)**:
   - Department pass rate metrics (87.4%), hostel residency rates, and faculty workload capacity monitoring (112%).
   - Pending course approvals queue (grade submissions, syllabus updates, curriculum proposals).
   - Departmental disciplinary & leave alert tracking.

6. 🏢 **Hostel Warden Operations (`Warden Portal`)**:
   - Total room occupancy tracking (470/500 rooms occupied - 94%).
   - Gate pass approval and verification workflow (Out-of-campus tracking).
   - Pending maintenance logs (leaky taps, AC issues, window latches) with status badges.
   - Mess schedule coordination and emergency response speed-dial buttons.

7. 👨‍🏫 **Faculty & Classroom Sync (`Teacher Portal`)**:
   - Daily teaching schedule with room locations, student counts, and hostel resident breakdown.
   - Classroom attendance marking modal and lesson plan review.
   - Action items (midterm lab report grading, unexcused absence verification).
   - Classroom-hostel sync alerts for sick leave and absence notices.

---

## 🎨 Design System & Architecture
- **Design Tokens**: Extended Material 3 palette using Deep Navy (`#0b1c30`), Professional Blue (`#0051d5`), Slate Grays, Clean Off-White (`#f8f9ff`), and Semantic Status Colors.
- **Universal Role Switcher Bar**: Switch between all 7 institutional portals dynamically from the top header or persistent sidebar without page reloads.
- **Interactive Modals**: Out-of-Campus Gate Pass requests, Fee Payments, User Onboarding, Announcement Broadcasts, and Invoice Creation.
- **Toast Alerts**: Non-intrusive notification toasts for system updates, payments, gate pass approvals, and mode toggles.
- **Theme Support**: Dark Mode and Light Mode support with smooth transition effects.
- **Persistence**: File-backed database store in `db.json` automatically updated by REST API operations.

---

## 🚀 File Structure
- [`server.js`](file:///d:/collage%20erp/server.js) — Express REST API backend server with persistence in `db.json`.
- [`package.json`](file:///d:/collage%20erp/package.json) — Node.js package manifest.
- [`index.html`](file:///d:/collage%20erp/index.html) — Core application shell, top bar, role selector, sidebar, modal container, and notifications dropdown.
- [`css/styles.css`](file:///d:/collage%20erp/css/styles.css) — Custom glassmorphic cards, scrollbars, status badges, animations, and dark mode support.
- [`js/data.js`](file:///d:/collage%20erp/js/data.js) — Client-side database model with REST API data synchronization.
- [`js/portals.js`](file:///d:/collage%20erp/js/portals.js) — HTML template renderers for all 7 institutional portal views.
- [`js/app.js`](file:///d:/collage%20erp/js/app.js) — State controller, role switcher engine, modal manager, toast controller, and REST API fetch client.

---

*Academic Nexus v2.4.0 — Unified SIS & College ERP Portal Ecosystem*
