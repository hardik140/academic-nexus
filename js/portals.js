// Academic Nexus — Production SaaS Portals Template Engine
const Portals = {

  // 1. Student Portal (My Academic Hub)
  student: function() {
    return `
      <div class="space-y-lg md:space-y-xl animate-fade-in">
        <!-- Top Banner / Welcome -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div>
            <div class="flex items-center gap-sm mb-xs">
              <span class="px-sm py-xs bg-secondary-container/20 text-secondary font-label-md rounded-full text-xs font-semibold">Active Semester</span>
              <span class="text-body-sm text-on-surface-variant font-mono-code">ID: STU-2024-8841</span>
            </div>
            <h1 class="font-display-lg text-display-lg text-on-surface">Welcome back, Alex.</h1>
            <p class="font-body-lg text-body-lg text-on-surface-variant mt-xs">Fall Semester 2024 • Computer Science Major • B.Tech Year 3</p>
          </div>
          <div class="flex flex-wrap gap-sm">
            <button onclick="ERPApp.openModal('gatepass')" class="bg-secondary text-on-secondary px-lg py-md rounded-xl font-label-md hover:bg-secondary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">directions_walk</span> Request Gate Pass
            </button>
            <button onclick="ERPApp.openModal('payfee')" class="bg-primary text-on-primary px-lg py-md rounded-xl font-label-md hover:bg-primary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">payments</span> Pay Fees
            </button>
            <button onclick="ERPApp.exportTableCSV('Student Schedule', ERP_DATA.schedule)" class="bg-surface-container-high text-primary px-md py-md rounded-xl font-label-md hover:bg-surface-container-highest transition-all flex items-center gap-xs font-semibold border border-outline-variant" title="Export Schedule to CSV">
              <span class="material-symbols-outlined text-[18px]">download</span> Export CSV
            </button>
          </div>
        </div>

        <!-- Bento Grid Layout -->
        <div class="grid grid-cols-1 md:grid-cols-12 gap-md md:gap-lg">
          <!-- Academic Progress (8 Cols) -->
          <div class="md:col-span-8 bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-secondary transition-all flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-start mb-md">
                <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
                  <span class="material-symbols-outlined text-secondary">school</span> Academic Progress
                </h3>
                <div class="text-right">
                  <p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Cumulative GPA</p>
                  <p class="font-display-lg text-display-lg text-primary font-extrabold">3.84</p>
                </div>
              </div>
              <div class="mb-lg">
                <div class="flex justify-between items-end mb-xs">
                  <p class="font-label-md text-label-md text-on-surface-variant uppercase">Degree Credits Completed</p>
                  <p class="font-body-md text-body-md text-on-surface font-semibold">85 / 120 Credits</p>
                </div>
                <div class="w-full bg-surface-container-high rounded-full h-3">
                  <div class="bg-secondary h-3 rounded-full transition-all duration-1000" style="width: 70.8%"></div>
                </div>
              </div>
            </div>
            <!-- Recent Grades Cards -->
            <div class="grid grid-cols-3 gap-md pt-md border-t border-outline-variant/60">
              <div class="bg-surface-container-low p-md rounded-xl text-center border border-outline-variant/30">
                <p class="font-label-md text-label-md text-on-surface-variant truncate">Math 301 (Calculus)</p>
                <p class="font-headline-sm text-headline-sm text-secondary font-bold mt-xs">A- (92%)</p>
              </div>
              <div class="bg-surface-container-low p-md rounded-xl text-center border border-outline-variant/30">
                <p class="font-label-md text-label-md text-on-surface-variant truncate">Physics II Lab</p>
                <p class="font-headline-sm text-headline-sm text-secondary font-bold mt-xs">B+ (88%)</p>
              </div>
              <div class="bg-surface-container-low p-md rounded-xl text-center border border-outline-variant/30">
                <p class="font-label-md text-label-md text-on-surface-variant truncate">Data Structures</p>
                <p class="font-headline-sm text-headline-sm text-secondary font-bold mt-xs">A (96%)</p>
              </div>
            </div>
          </div>

          <!-- Finance & Dues Widget (4 Cols) -->
          <div class="md:col-span-4 bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm flex flex-col justify-between hover:border-error transition-all relative overflow-hidden">
            <div class="absolute top-0 right-0 w-32 h-32 bg-error/5 rounded-bl-full pointer-events-none"></div>
            <div>
              <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm mb-lg relative z-10">
                <span class="material-symbols-outlined text-error">account_balance_wallet</span> Finance &amp; Fees
              </h3>
              <p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-xs">Outstanding Balance</p>
              <p class="font-display-lg text-display-lg text-error font-mono-code font-bold">$1,250.00</p>
              <div class="mt-md bg-error-container/40 p-sm rounded-xl border border-error/20 flex items-center gap-sm">
                <span class="material-symbols-outlined text-error text-[18px]">event</span>
                <span class="font-body-sm text-body-sm text-on-error-container font-medium">Due Date: Nov 15, 2024</span>
              </div>
            </div>
            <button onclick="ERPApp.openModal('payfee')" class="w-full bg-secondary text-on-secondary font-label-md text-label-md uppercase tracking-wider py-md rounded-xl mt-lg hover:bg-secondary-container transition-all shadow-sm font-bold flex items-center justify-center gap-sm">
              <span class="material-symbols-outlined text-[18px]">credit_card</span> Pay Outstanding Fee
            </button>
          </div>

          <!-- Schedule & Attendance (12 Cols Table) -->
          <div class="md:col-span-12 bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm overflow-hidden">
            <div class="p-lg border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
              <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">calendar_today</span> Today's Class Schedule
              </h3>
              <div class="flex items-center gap-sm">
                <span class="font-label-md text-label-md text-on-surface-variant bg-surface-container-high px-md py-xs rounded-full font-medium">Monday, Oct 24</span>
                <span class="badge-status badge-success">Overall Attendance: 94.2%</span>
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="bg-surface-container text-on-surface-variant font-label-md text-label-md uppercase tracking-wider border-b border-outline-variant/60">
                    <th class="p-md">Time</th>
                    <th class="p-md">Course Name</th>
                    <th class="p-md">Room / Venue</th>
                    <th class="p-md">Instructor</th>
                    <th class="p-md text-right">Attendance Status</th>
                  </tr>
                </thead>
                <tbody class="font-body-md text-body-md text-on-surface divide-y divide-outline-variant/40">
                  ${ERP_DATA.schedule.map(s => `
                    <tr class="hover:bg-surface-container-low transition-colors">
                      <td class="p-md font-mono-code text-on-surface-variant">${s.time}</td>
                      <td class="p-md font-semibold text-primary">${s.name}</td>
                      <td class="p-md text-on-surface-variant">${s.room}</td>
                      <td class="p-md text-on-surface-variant">${s.instructor}</td>
                      <td class="p-md text-right">
                        <span class="badge-status ${s.badge}">
                          <span class="material-symbols-outlined text-[14px]">${s.icon}</span> ${s.status}
                        </span>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Hostel & Mess Info (6 Cols) -->
          <div class="md:col-span-6 bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm mb-md">
              <span class="material-symbols-outlined text-secondary">location_city</span> Hostel &amp; Dining Information
            </h3>
            <div class="flex items-center gap-md mb-lg p-md bg-surface-container-low rounded-xl border border-outline-variant/50">
              <div class="bg-primary text-on-primary w-14 h-14 rounded-2xl flex items-center justify-center font-headline-md font-bold shadow-sm">
                B4
              </div>
              <div>
                <p class="font-label-md text-label-md text-on-surface-variant uppercase">Boys Hostel Block B</p>
                <p class="font-headline-sm text-headline-sm text-on-surface">Room 402 • Double Occupancy</p>
                <p class="font-body-sm text-body-sm text-secondary font-medium">Roommate: David Miller (CS)</p>
              </div>
            </div>
            <div class="border-t border-outline-variant pt-md">
              <div class="flex justify-between items-center mb-sm">
                <p class="font-label-md text-label-md text-on-surface-variant uppercase flex items-center gap-xs">
                  <span class="material-symbols-outlined text-[16px]">restaurant_menu</span> Today's Mess Menu
                </p>
                <span class="text-xs font-mono-code text-secondary">Mess Rating: 4.2 ★</span>
              </div>
              <ul class="space-y-sm font-body-sm text-body-sm text-on-surface bg-surface-container-low p-md rounded-xl">
                <li class="flex justify-between border-b border-outline-variant/30 pb-xs"><span class="text-on-surface-variant font-medium">Breakfast</span> <span>Oatmeal, Scrambled Eggs, Coffee</span></li>
                <li class="flex justify-between border-b border-outline-variant/30 pb-xs"><span class="text-on-surface-variant font-medium">Lunch</span> <span>Grilled Chicken Wrap, Quinoa Salad</span></li>
                <li class="flex justify-between"><span class="text-on-surface-variant font-medium">Dinner</span> <span>Spaghetti Bolognese, Garlic Bread</span></li>
              </ul>
            </div>
          </div>

          <!-- Announcements (6 Cols) -->
          <div class="md:col-span-6 bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <div class="flex justify-between items-center mb-md">
              <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">campaign</span> Portal Announcements
              </h3>
              <span class="text-xs text-secondary font-semibold">Updated 10m ago</span>
            </div>
            <div class="space-y-md">
              ${ERP_DATA.announcements.map(a => `
                <div class="p-md rounded-xl border border-outline-variant/50 bg-surface-container-low hover:border-secondary transition-all cursor-pointer">
                  <div class="flex justify-between items-start mb-xs">
                    <h4 class="font-headline-sm text-headline-sm text-on-surface font-semibold">${a.title}</h4>
                    <span class="px-xs py-0.5 bg-secondary-container/20 text-secondary text-[10px] font-bold rounded-full">${a.category}</span>
                  </div>
                  <p class="font-body-sm text-body-sm text-on-surface-variant">${a.body}</p>
                  <p class="font-label-md text-label-md text-outline mt-xs">${a.time}</p>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // 2. Super Admin Console
  admin: function() {
    return `
      <div class="space-y-lg md:space-y-xl animate-fade-in">
        <!-- Admin Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div>
            <div class="flex items-center gap-sm mb-xs">
              <span class="badge-status badge-success"><span class="pulse-dot bg-emerald-600"></span> System Operational</span>
              <span class="text-body-sm text-on-surface-variant font-mono-code">Build v2.4.0-release</span>
            </div>
            <h1 class="font-display-lg text-display-lg text-on-surface">Institutional Admin Control</h1>
            <p class="font-body-lg text-body-lg text-on-surface-variant">Global configurations, user access control, database sync, and security logs.</p>
          </div>
          <div class="flex flex-wrap gap-sm">
            <button onclick="ERPApp.openModal('adduser')" class="bg-secondary text-on-secondary px-lg py-md rounded-xl font-label-md hover:bg-secondary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">person_add</span> Onboard User
            </button>
            <button onclick="ERPApp.exportTableCSV('Audit Logs', ERP_DATA.auditLogs)" class="bg-surface-container-high text-primary px-md py-md rounded-xl font-label-md hover:bg-surface-container-highest transition-all flex items-center gap-xs font-semibold border border-outline-variant">
              <span class="material-symbols-outlined text-[18px]">download</span> Export Audit CSV
            </button>
            <button onclick="ERPApp.triggerSync()" class="bg-primary text-on-primary px-lg py-md rounded-xl font-label-md hover:bg-primary-container transition-all flex items-center gap-sm font-semibold border border-outline-variant">
              <span class="material-symbols-outlined text-[18px]">sync</span> Trigger Global Sync
            </button>
          </div>
        </div>

        <!-- Health Grid -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-md">
          <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm hover:border-secondary transition-all">
            <div class="flex justify-between items-start mb-md">
              <div>
                <p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Core Infrastructure Uptime</p>
                <h4 class="font-display-lg text-display-lg text-on-surface mt-xs font-bold">99.98%</h4>
              </div>
              <span class="material-symbols-outlined text-[#10B981] bg-[#D1FAE5] p-2 rounded-xl">check_circle</span>
            </div>
            <div class="w-full bg-surface-container h-2 rounded-full overflow-hidden">
              <div class="bg-[#10B981] h-full rounded-full" style="width: 99.98%"></div>
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant mt-sm">Zero critical outages in last 30 days</p>
          </div>

          <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm hover:border-secondary transition-all">
            <div class="flex justify-between items-start mb-md">
              <div>
                <p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Avg Latency Response</p>
                <h4 class="font-display-lg text-display-lg text-on-surface mt-xs font-bold">124<span class="text-headline-sm text-on-surface-variant font-normal">ms</span></h4>
              </div>
              <span class="material-symbols-outlined text-secondary bg-secondary-fixed p-2 rounded-xl">speed</span>
            </div>
            <p class="font-body-sm text-body-sm text-emerald-600 font-medium flex items-center gap-xs">
              <span class="material-symbols-outlined text-[16px]">arrow_downward</span> 12ms faster than peak hours
            </p>
          </div>

          <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm hover:border-secondary transition-all">
            <p class="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider mb-sm">Active Integrations</p>
            <div class="space-y-xs text-body-sm">
              <div class="flex justify-between items-center"><span class="flex items-center gap-xs"><span class="w-2 h-2 rounded-full bg-emerald-500"></span> Canvas LMS Sync</span> <span class="font-mono-code text-xs">2m ago</span></div>
              <div class="flex justify-between items-center"><span class="flex items-center gap-xs"><span class="w-2 h-2 rounded-full bg-emerald-500"></span> Payment Gateway API</span> <span class="font-mono-code text-xs">Live</span></div>
              <div class="flex justify-between items-center"><span class="flex items-center gap-xs"><span class="w-2 h-2 rounded-full bg-rose-500"></span> Hostel Biometrics Gate</span> <span class="font-mono-code text-xs text-rose-600 font-bold">Sync Failure</span></div>
            </div>
          </div>
        </div>

        <!-- Audit Logs & System Modules -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
          <!-- Audit Logs (8 cols) -->
          <div class="lg:col-span-8 bg-surface-container-lowest rounded-2xl border border-outline-variant shadow-sm overflow-hidden">
            <div class="p-lg border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
              <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">history</span> Real-Time Audit Trail
              </h3>
              <button onclick="ERPApp.openModal('auditlog')" class="font-label-md text-label-md text-secondary hover:underline">View Full Log</button>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="bg-surface-container text-on-surface-variant font-label-md text-label-md uppercase tracking-wider border-b border-outline-variant/60">
                    <th class="p-md">Timestamp</th>
                    <th class="p-md">Actor / Role</th>
                    <th class="p-md">Action Event</th>
                  </tr>
                </thead>
                <tbody class="font-body-md text-body-md text-on-surface divide-y divide-outline-variant/40">
                  ${ERP_DATA.auditLogs.map(log => `
                    <tr class="hover:bg-surface-container-low transition-colors">
                      <td class="p-md font-mono-code text-on-surface-variant text-xs">${log.time}</td>
                      <td class="p-md font-medium flex items-center gap-sm">
                        <span class="w-7 h-7 rounded-full ${log.alert ? 'bg-error-container text-on-error-container' : 'bg-secondary-container text-on-secondary-container'} flex items-center justify-center text-xs font-bold">${log.roleBadge}</span>
                        ${log.user}
                      </td>
                      <td class="p-md ${log.alert ? 'text-error font-semibold' : ''}">${log.action}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Quick User Management (4 cols) -->
          <div class="lg:col-span-4 bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm flex flex-col justify-between">
            <div>
              <h3 class="font-headline-md text-headline-md text-on-surface mb-md flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">manage_accounts</span> User Metrics
              </h3>
              <div class="grid grid-cols-3 gap-sm mb-lg">
                <div class="bg-surface-container-low p-sm rounded-xl text-center">
                  <span class="font-headline-md text-headline-md text-primary font-bold block">1,204</span>
                  <span class="text-[10px] text-on-surface-variant font-semibold uppercase">Users</span>
                </div>
                <div class="bg-error-container/30 border border-error/20 p-sm rounded-xl text-center">
                  <span class="font-headline-md text-headline-md text-error font-bold block">12</span>
                  <span class="text-[10px] text-on-surface-variant font-semibold uppercase">Pending</span>
                </div>
                <div class="bg-surface-container-low p-sm rounded-xl text-center">
                  <span class="font-headline-md text-headline-md text-primary font-bold block">850</span>
                  <span class="text-[10px] text-on-surface-variant font-semibold uppercase">Residing</span>
                </div>
              </div>
            </div>
            <div class="space-y-sm">
              <button onclick="ERPApp.openModal('adduser')" class="w-full flex items-center justify-between p-md rounded-xl border border-outline-variant hover:border-secondary hover:bg-surface-container-low transition-all font-medium">
                <span class="flex items-center gap-sm"><span class="material-symbols-outlined text-secondary">person_add</span> Add New User Profile</span>
                <span class="material-symbols-outlined text-outline">chevron_right</span>
              </button>
              <button onclick="ERPApp.openModal('roles')" class="w-full flex items-center justify-between p-md rounded-xl border border-outline-variant hover:border-secondary hover:bg-surface-container-low transition-all font-medium">
                <span class="flex items-center gap-sm"><span class="material-symbols-outlined text-secondary">admin_panel_settings</span> Manage Role Permissions</span>
                <span class="material-symbols-outlined text-outline">chevron_right</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // 3. Director View (Institutional View)
  director: function() {
    return `
      <div class="space-y-lg md:space-y-xl animate-fade-in">
        <!-- Director Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div>
            <span class="badge-status badge-info mb-xs">Executive Control Portal</span>
            <h1 class="font-display-lg text-display-lg text-on-surface">Director's 360 View</h1>
            <p class="font-body-lg text-body-lg text-on-surface-variant">Real-time institutional performance metrics, accreditation, budget variance, and critical campus alerts.</p>
          </div>
          <button onclick="ERPApp.openModal('announcement')" class="bg-secondary text-on-secondary px-lg py-md rounded-xl font-label-md hover:bg-secondary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
            <span class="material-symbols-outlined text-[18px]">campaign</span> Broadcast Announcement
          </button>
        </div>

        <!-- 5 KPI Cards Row -->
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-md">
          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-md shadow-sm hover:border-secondary transition-all">
            <div class="flex justify-between items-start mb-sm">
              <span class="text-xs font-semibold text-on-surface-variant uppercase">Total Enrollment</span>
              <span class="material-symbols-outlined text-secondary">groups</span>
            </div>
            <div class="font-display-lg text-display-lg text-on-surface font-bold">12,450</div>
            <div class="text-xs text-emerald-600 font-semibold mt-xs flex items-center gap-xs"><span class="material-symbols-outlined text-xs">trending_up</span> +4.2% YoY Growth</div>
          </div>

          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-md shadow-sm hover:border-secondary transition-all">
            <div class="flex justify-between items-start mb-sm">
              <span class="text-xs font-semibold text-on-surface-variant uppercase">Revenue vs Target</span>
              <span class="material-symbols-outlined text-secondary">account_balance_wallet</span>
            </div>
            <div class="font-display-lg text-display-lg text-on-surface font-bold">$42.1M</div>
            <div class="text-xs text-rose-600 font-semibold mt-xs flex items-center gap-xs"><span class="material-symbols-outlined text-xs">trending_down</span> -1.5% Gap</div>
          </div>

          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-md shadow-sm hover:border-secondary transition-all">
            <div class="flex justify-between items-start mb-sm">
              <span class="text-xs font-semibold text-on-surface-variant uppercase">Pass Rate</span>
              <span class="material-symbols-outlined text-secondary">school</span>
            </div>
            <div class="font-display-lg text-display-lg text-on-surface font-bold">88.4%</div>
            <div class="text-xs text-emerald-600 font-semibold mt-xs flex items-center gap-xs"><span class="material-symbols-outlined text-xs">trending_up</span> +2.1% Prev Sem</div>
          </div>

          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-md shadow-sm hover:border-error transition-all relative overflow-hidden">
            <div class="flex justify-between items-start mb-sm">
              <span class="text-xs font-semibold text-on-surface-variant uppercase">Compliance Score</span>
              <span class="material-symbols-outlined text-error">warning</span>
            </div>
            <div class="font-display-lg text-display-lg text-on-surface font-bold">94%</div>
            <div class="text-xs text-error font-semibold mt-xs">2 Action Items Pending</div>
          </div>

          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-md shadow-sm hover:border-secondary transition-all">
            <div class="flex justify-between items-start mb-sm">
              <span class="text-xs font-semibold text-on-surface-variant uppercase">Hostel Occupancy</span>
              <span class="material-symbols-outlined text-secondary">bed</span>
            </div>
            <div class="font-display-lg text-display-lg text-on-surface font-bold">92%</div>
            <div class="text-xs text-secondary font-semibold mt-xs">Across All Blocks</div>
          </div>
        </div>

        <!-- Main Chart Section -->
        <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm">
          <div class="flex justify-between items-center mb-md border-b border-outline-variant/60 pb-sm">
            <h3 class="font-headline-md text-headline-md text-on-surface font-semibold flex items-center gap-sm">
              <span class="material-symbols-outlined text-secondary">monitoring</span> Institutional YoY Trends Analytics
            </h3>
            <span class="text-xs text-on-surface-variant font-mono-code">Updated 5m ago</span>
          </div>
          ${ERPCharts.renderDirectorTrendChart()}
        </div>

        <!-- Departmental Performance Table -->
        <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant shadow-sm overflow-hidden">
          <div class="p-lg border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
            <h3 class="font-headline-md text-headline-md text-on-surface">Departmental Performance Leaderboard</h3>
            <span class="text-xs font-mono-code text-on-surface-variant">Term 2 Analytics</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="bg-surface-container text-on-surface-variant font-label-md text-label-md uppercase tracking-wider border-b border-outline-variant/60">
                  <th class="p-md">Department</th>
                  <th class="p-md">Head of Dept (HOD)</th>
                  <th class="p-md text-right">Pass Rate</th>
                  <th class="p-md text-right">Budget Variance</th>
                  <th class="p-md text-center">Operational Status</th>
                </tr>
              </thead>
              <tbody class="font-body-md text-body-md text-on-surface divide-y divide-outline-variant/40">
                <tr class="hover:bg-surface-container-low transition-colors">
                  <td class="p-md font-semibold">Computer Science</td>
                  <td class="p-md text-on-surface-variant">Dr. Alan Turing</td>
                  <td class="p-md text-right font-mono-code font-bold text-emerald-600">92.5%</td>
                  <td class="p-md text-right font-mono-code text-secondary font-semibold">+$12,000</td>
                  <td class="p-md text-center"><span class="badge-status badge-success">Optimal</span></td>
                </tr>
                <tr class="hover:bg-surface-container-low transition-colors">
                  <td class="p-md font-semibold">Arts &amp; Humanities</td>
                  <td class="p-md text-on-surface-variant">Prof. M. Atwood</td>
                  <td class="p-md text-right font-mono-code font-bold text-emerald-600">89.1%</td>
                  <td class="p-md text-right font-mono-code text-on-surface-variant">-$2,400</td>
                  <td class="p-md text-center"><span class="badge-status badge-info">Stable</span></td>
                </tr>
                <tr class="hover:bg-surface-container-low transition-colors">
                  <td class="p-md font-semibold">Mechanical Engineering</td>
                  <td class="p-md text-on-surface-variant">Dr. N. Tesla</td>
                  <td class="p-md text-right font-mono-code font-bold text-rose-600">79.4%</td>
                  <td class="p-md text-right font-mono-code text-rose-600 font-semibold">-$18,500</td>
                  <td class="p-md text-center"><span class="badge-status badge-danger">Review Required</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  // 4. Finance & Hostel Billing
  finance: function() {
    return `
      <div class="space-y-lg md:space-y-xl animate-fade-in">
        <!-- Finance Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div>
            <span class="badge-status badge-info mb-xs">Billed &amp; Accounts Ledger</span>
            <h1 class="font-display-lg text-display-lg text-on-surface">Finance &amp; Hostel Billing</h1>
            <p class="font-body-lg text-body-lg text-on-surface-variant">Manage term receivables, hostel fee collection, mess dues, and scholarship disbursements.</p>
          </div>
          <div class="flex flex-wrap gap-sm">
            <button onclick="ERPApp.openModal('createinvoice')" class="bg-secondary text-on-secondary px-lg py-md rounded-xl font-label-md hover:bg-secondary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">receipt_long</span> Create Invoice
            </button>
            <button onclick="ERPApp.openModal('payfee')" class="bg-primary text-on-primary px-lg py-md rounded-xl font-label-md hover:bg-primary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">payments</span> Record Payment
            </button>
            <button onclick="ERPApp.exportTableCSV('Transactions Ledger', ERP_DATA.transactions)" class="bg-surface-container-high text-primary px-md py-md rounded-xl font-label-md hover:bg-surface-container-highest transition-all flex items-center gap-xs font-semibold border border-outline-variant">
              <span class="material-symbols-outlined text-[18px]">download</span> Export Ledger CSV
            </button>
          </div>
        </div>

        <!-- Receivables & Donut Chart Row -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
          <!-- Receivables (8 cols) -->
          <div class="lg:col-span-8 bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm flex flex-col justify-between">
            <div class="mb-md">
              <h3 class="font-headline-md text-headline-md text-on-surface font-semibold mb-sm">Term Receivables Overview</h3>
              ${ERPCharts.renderFinanceGauge(68)}
            </div>
            <div class="grid grid-cols-3 gap-md pt-md border-t border-outline-variant/50">
              <div class="bg-surface-container-low p-md rounded-xl border border-outline-variant/30">
                <p class="font-label-md text-label-md text-on-surface-variant">Scholarships Applied</p>
                <p class="font-headline-sm text-headline-sm text-primary font-mono-code font-bold mt-xs">$450,000</p>
              </div>
              <div class="bg-surface-container-low p-md rounded-xl border border-outline-variant/30">
                <p class="font-label-md text-label-md text-on-surface-variant">Hostel &amp; Mess Fees</p>
                <p class="font-headline-sm text-headline-sm text-primary font-mono-code font-bold mt-xs">$820,000</p>
              </div>
              <div class="bg-error-container/30 border border-error/20 p-md rounded-xl">
                <p class="font-label-md text-label-md text-on-surface-variant">Unbilled Dues</p>
                <p class="font-headline-sm text-headline-sm text-error font-mono-code font-bold mt-xs">$12,400</p>
              </div>
            </div>
          </div>

          <!-- Aged AR (4 cols) -->
          <div class="lg:col-span-4 bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm flex flex-col justify-between">
            <div>
              <div class="flex justify-between items-start mb-md">
                <h3 class="font-headline-md text-headline-md text-on-surface font-semibold">Outstanding Dues</h3>
                <span class="material-symbols-outlined text-error">warning</span>
              </div>
              <div class="space-y-md">
                <div class="flex justify-between items-center">
                  <span class="text-body-md text-on-surface-variant">Tuition Dues</span>
                  <span class="font-mono-code font-bold text-primary">$85,400</span>
                </div>
                <div class="flex justify-between items-center">
                  <span class="text-body-md text-on-surface-variant">Room Rent Dues</span>
                  <span class="font-mono-code font-bold text-primary">$42,100</span>
                </div>
                <div class="flex justify-between items-center text-error">
                  <span class="text-body-md font-semibold">90+ Days Overdue</span>
                  <span class="font-mono-code font-bold">$28,500</span>
                </div>
              </div>
            </div>
            <div class="pt-md border-t border-outline-variant mt-lg flex justify-between items-center">
              <span class="font-label-md text-label-md uppercase text-on-surface-variant">Total Overdue</span>
              <span class="font-headline-md text-headline-md text-error font-mono-code font-extrabold">$156,000</span>
            </div>
          </div>
        </div>

        <!-- Recent Transactions Table -->
        <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant shadow-sm overflow-hidden">
          <div class="p-lg border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
            <h3 class="font-headline-md text-headline-md text-on-surface">Recent Fee &amp; Billing Transactions</h3>
            <button onclick="ERPApp.openModal('createinvoice')" class="font-label-md text-label-md text-secondary hover:underline">+ New Invoice</button>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="bg-surface-container text-on-surface-variant font-label-md text-label-md uppercase tracking-wider border-b border-outline-variant/60">
                  <th class="p-md">Txn ID</th>
                  <th class="p-md">Date &amp; Time</th>
                  <th class="p-md">Student / Payer</th>
                  <th class="p-md">Type</th>
                  <th class="p-md text-right">Amount</th>
                  <th class="p-md text-center">Status</th>
                  <th class="p-md text-right">Print</th>
                </tr>
              </thead>
              <tbody class="font-body-md text-body-md text-on-surface divide-y divide-outline-variant/40">
                ${ERP_DATA.transactions.map(t => `
                  <tr class="hover:bg-surface-container-low transition-colors">
                    <td class="p-md font-mono-code text-secondary font-semibold">${t.id}</td>
                    <td class="p-md text-on-surface-variant text-xs">${t.date}</td>
                    <td class="p-md font-medium">${t.student} <span class="text-xs text-outline font-mono-code">(${t.sid})</span></td>
                    <td class="p-md">${t.type}</td>
                    <td class="p-md text-right font-mono-code font-bold text-primary">${t.amount}</td>
                    <td class="p-md text-center"><span class="badge-status ${t.badge}">${t.status}</span></td>
                    <td class="p-md text-right">
                      <button onclick="ERPApp.printReceipt('${t.id}')" class="text-secondary hover:text-secondary-container transition-colors" title="Print Receipt"><span class="material-symbols-outlined text-[18px]">print</span></button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  // 5. HOD Departmental Control
  hod: function() {
    return `
      <div class="space-y-lg md:space-y-xl animate-fade-in">
        <!-- HOD Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div>
            <span class="badge-status badge-info mb-xs">Department of Computer Science</span>
            <h1 class="font-display-lg text-display-lg text-on-surface">Department Overview</h1>
            <p class="font-body-lg text-body-lg text-on-surface-variant">Faculty allocation, syllabus completion, student performance risk, and departmental hostel sync.</p>
          </div>
          <div class="flex gap-sm">
            <button onclick="ERPApp.openModal('proposal')" class="bg-secondary text-on-secondary px-lg py-md rounded-xl font-label-md hover:bg-secondary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">add</span> New Curriculum Proposal
            </button>
          </div>
        </div>

        <!-- 4 KPI Cards -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-md">
          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-secondary transition-all">
            <p class="font-label-md text-label-md text-on-surface-variant uppercase">Dept. Pass Rate</p>
            <h4 class="font-display-lg text-display-lg text-on-surface font-bold mt-xs">87.4%</h4>
            <div class="w-full bg-surface-container h-2 rounded-full mt-md overflow-hidden">
              <div class="bg-secondary h-2 rounded-full" style="width: 87.4%"></div>
            </div>
          </div>

          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-secondary transition-all">
            <p class="font-label-md text-label-md text-on-surface-variant uppercase">Hostel Residents</p>
            <h4 class="font-display-lg text-display-lg text-on-surface font-bold mt-xs">65%</h4>
            <p class="text-xs text-on-surface-variant mt-sm">240 active CS hostel residents</p>
          </div>

          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-error transition-all">
            <p class="font-label-md text-label-md text-on-surface-variant uppercase">Health / Sick Leave</p>
            <h4 class="font-display-lg text-display-lg text-error font-bold mt-xs">3</h4>
            <p class="text-xs text-error font-medium mt-sm">Students seeking medical care</p>
          </div>

          <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm hover:border-error transition-all">
            <p class="font-label-md text-label-md text-on-surface-variant uppercase">Faculty Load Capacity</p>
            <h4 class="font-display-lg text-display-lg text-rose-600 font-bold mt-xs">112%</h4>
            <p class="text-xs text-rose-600 font-medium mt-sm">2 faculty over max teaching hours</p>
          </div>
        </div>

        <!-- Pending Approvals & Faculty Status -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
          <div class="lg:col-span-8 bg-surface-container-lowest rounded-2xl border border-outline-variant shadow-sm overflow-hidden">
            <div class="p-lg border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
              <h3 class="font-headline-md text-headline-md text-on-surface font-semibold">Pending Course &amp; Grade Approvals</h3>
              <span class="text-xs text-secondary font-semibold">3 Approvals Queue</span>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="bg-surface-container text-on-surface-variant font-label-md text-label-md uppercase border-b border-outline-variant/60">
                    <th class="p-md">Course Code &amp; Name</th>
                    <th class="p-md">Instructor</th>
                    <th class="p-md">Submission Type</th>
                    <th class="p-md text-right">Action</th>
                  </tr>
                </thead>
                <tbody class="font-body-md text-body-md text-on-surface divide-y divide-outline-variant/40">
                  <tr class="hover:bg-surface-container-low transition-colors">
                    <td class="p-md font-semibold">CS101 - Intro to Programming</td>
                    <td class="p-md">Dr. Smith</td>
                    <td class="p-md"><span class="badge-status badge-info">Midterm Grades</span></td>
                    <td class="p-md text-right">
                      <button onclick="ERPApp.openModal('approverequest')" class="bg-secondary text-on-secondary px-md py-xs rounded-lg text-xs font-semibold hover:bg-secondary-container transition-all">Approve</button>
                    </td>
                  </tr>
                  <tr class="hover:bg-surface-container-low transition-colors">
                    <td class="p-md font-semibold">CS305 - Data Structures</td>
                    <td class="p-md">Prof. Johnson</td>
                    <td class="p-md"><span class="badge-status badge-warning">Syllabus Update</span></td>
                    <td class="p-md text-right">
                      <button onclick="ERPApp.openModal('approverequest')" class="bg-secondary text-on-secondary px-md py-xs rounded-lg text-xs font-semibold hover:bg-secondary-container transition-all">Approve</button>
                    </td>
                  </tr>
                  <tr class="hover:bg-surface-container-low transition-colors">
                    <td class="p-md font-semibold">CS450 - Machine Learning</td>
                    <td class="p-md">Dr. Lee</td>
                    <td class="p-md"><span class="badge-status badge-success">Final Grades</span></td>
                    <td class="p-md text-right">
                      <button onclick="ERPApp.openModal('approverequest')" class="bg-secondary text-on-secondary px-md py-xs rounded-lg text-xs font-semibold hover:bg-secondary-container transition-all">Approve</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="lg:col-span-4 bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm">
            <h3 class="font-headline-md text-headline-md text-on-surface mb-md font-semibold">Department Alerts</h3>
            <div class="space-y-sm">
              <div class="p-md rounded-xl bg-error-container/30 border border-error/20">
                <p class="font-label-md text-label-md text-error font-semibold">Hostel Leave Pending</p>
                <p class="text-xs text-on-surface mt-xs">12 CS department students awaiting warden &amp; HOD leave clearance.</p>
              </div>
              <div class="p-md rounded-xl bg-error-container/30 border border-error/20">
                <p class="font-label-md text-label-md text-error font-semibold">Curfew Violations</p>
                <p class="text-xs text-on-surface mt-xs">2 new night attendance curfew alerts reported by Warden.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // 6. Hostel Warden Portal
  warden: function() {
    return `
      <div class="space-y-lg md:space-y-xl animate-fade-in">
        <!-- Warden Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div>
            <span class="badge-status badge-success mb-xs">Boys Hostel Block B &amp; C Control</span>
            <h1 class="font-display-lg text-display-lg text-on-surface">Hostel Warden Operations</h1>
            <p class="font-body-lg text-body-lg text-on-surface-variant">Real-time room occupancy, gate pass verification, maintenance logs, and mess menu coordination.</p>
          </div>
          <div class="flex flex-wrap gap-sm">
            <button onclick="ERPApp.openModal('gatepass')" class="bg-secondary text-on-secondary px-lg py-md rounded-xl font-label-md hover:bg-secondary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">verified</span> Verify Gate Pass
            </button>
            <button onclick="ERPApp.openModal('maintenance')" class="bg-primary text-on-primary px-lg py-md rounded-xl font-label-md hover:bg-primary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">build</span> Log Maintenance Issue
            </button>
          </div>
        </div>

        <!-- Hostel Occupancy & Maintenance Row -->
        <div class="grid grid-cols-1 md:grid-cols-12 gap-lg">
          <div class="md:col-span-6 bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
            <h3 class="font-headline-md text-headline-md text-on-surface font-semibold mb-md">Hostel Block Occupancy Breakdown</h3>
            ${ERPCharts.renderHostelOccupancyBar()}
          </div>

          <div class="md:col-span-6 bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm flex flex-col justify-between">
            <div>
              <h3 class="font-headline-md text-headline-md text-on-surface font-semibold mb-md">Warden Action Items</h3>
              <div class="space-y-sm">
                <div class="p-md rounded-xl bg-surface-container-low border border-outline-variant flex items-center justify-between">
                  <span class="font-medium text-on-surface">Out-of-Campus Active Passes</span>
                  <span class="font-mono-code font-bold text-secondary text-lg">12 Passes</span>
                </div>
                <div class="p-md rounded-xl bg-error-container/30 border border-error/20 flex items-center justify-between">
                  <span class="font-medium text-error">Pending Plumbing &amp; AC Repair Tickets</span>
                  <span class="font-mono-code font-bold text-error text-lg">5 Tickets</span>
                </div>
              </div>
            </div>
            <button onclick="ERPApp.openModal('maintenance')" class="w-full mt-md py-md bg-secondary text-on-secondary rounded-xl font-semibold hover:bg-secondary-container transition-all">Log New Maintenance Ticket</button>
          </div>
        </div>

        <!-- Gate Pass Table & Mess Schedule -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
          <!-- Gate Passes (8 cols) -->
          <div class="lg:col-span-8 bg-surface-container-lowest rounded-2xl border border-outline-variant shadow-sm overflow-hidden">
            <div class="p-lg border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
              <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">verified_user</span> Gate Pass Requests &amp; Status
              </h3>
              <button onclick="ERPApp.openModal('gatepass')" class="font-label-md text-label-md text-secondary hover:underline">+ Action Request</button>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="bg-surface-container text-on-surface-variant font-label-md text-label-md uppercase tracking-wider border-b border-outline-variant/60">
                    <th class="p-md">Pass ID</th>
                    <th class="p-md">Student &amp; Room</th>
                    <th class="p-md">Destination</th>
                    <th class="p-md">Exit &amp; Return</th>
                    <th class="p-md text-center">Status</th>
                    <th class="p-md text-right">Action</th>
                  </tr>
                </thead>
                <tbody class="font-body-md text-body-md text-on-surface divide-y divide-outline-variant/40">
                  ${ERP_DATA.gatePasses.map(g => `
                    <tr class="hover:bg-surface-container-low transition-colors">
                      <td class="p-md font-mono-code font-bold text-secondary">${g.id}</td>
                      <td class="p-md font-semibold">${g.student} <span class="text-xs text-outline font-normal">(${g.room})</span></td>
                      <td class="p-md">${g.destination}</td>
                      <td class="p-md text-xs font-mono-code text-on-surface-variant">${g.exit} <br/>to ${g.return}</td>
                      <td class="p-md text-center">
                        <span class="badge-status ${g.status === 'APPROVED' ? 'badge-success' : g.status === 'ACTIVE' ? 'badge-info' : 'badge-warning'}">${g.status}</span>
                      </td>
                      <td class="p-md text-right">
                        ${g.status === 'PENDING' ? `<button onclick="ERPApp.approveGatePass('${g.id}')" class="bg-secondary text-on-secondary px-sm py-xs rounded-lg text-xs font-semibold hover:bg-secondary-container">Approve</button>` : `<span class="text-xs text-outline">Verified</span>`}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Mess Menu & Maintenance List (4 cols) -->
          <div class="lg:col-span-4 space-y-md">
            <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm">
              <h3 class="font-headline-md text-headline-md text-on-surface mb-md flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">restaurant_menu</span> Today's Mess Schedule
              </h3>
              <ul class="space-y-sm text-body-sm bg-surface-container-low p-md rounded-xl">
                <li class="flex justify-between border-b border-outline-variant/30 pb-xs"><span>Breakfast</span> <span class="font-semibold">07:30 - 09:00</span></li>
                <li class="flex justify-between border-b border-outline-variant/30 pb-xs"><span class="text-secondary font-bold">Lunch (Active)</span> <span class="font-semibold">12:30 - 14:30</span></li>
                <li class="flex justify-between"><span>Dinner</span> <span class="font-semibold">19:30 - 21:00</span></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // 7. Teacher / Classroom Sync
  teacher: function() {
    return `
      <div class="space-y-lg md:space-y-xl animate-fade-in">
        <!-- Teacher Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div>
            <span class="badge-status badge-info mb-xs">Faculty &amp; Classroom Sync Portal</span>
            <h1 class="font-display-lg text-display-lg text-on-surface">Teacher &amp; Classroom Portal</h1>
            <p class="font-body-lg text-body-lg text-on-surface-variant">Classroom attendance marking, assignment grading, and real-time hostel absence sync.</p>
          </div>
          <div class="flex gap-sm">
            <button onclick="ERPApp.openModal('markattendance')" class="bg-secondary text-on-secondary px-lg py-md rounded-xl font-label-md hover:bg-secondary-container transition-all flex items-center gap-sm font-semibold shadow-sm">
              <span class="material-symbols-outlined text-[18px]">check_box</span> Mark Class Attendance
            </button>
          </div>
        </div>

        <!-- Schedule Cards -->
        <div class="bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm">
          <h3 class="font-headline-md text-headline-md text-on-surface mb-md flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">calendar_today</span> Today's Teaching Schedule
          </h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
            <div class="flex items-center justify-between p-md rounded-xl border border-outline-variant bg-surface-container-low hover:border-secondary transition-all">
              <div class="flex items-center gap-md">
                <div class="w-12 h-12 rounded-xl bg-secondary-container/20 text-secondary flex flex-col items-center justify-center font-bold text-xs">
                  <span>08:30</span>
                  <span class="text-[10px]">AM</span>
                </div>
                <div>
                  <h4 class="font-headline-sm text-headline-sm text-on-surface font-semibold">AP Physics C (Section A)</h4>
                  <p class="text-xs text-on-surface-variant">Room 302 • 28 Students • 12 Hostel Residents</p>
                </div>
              </div>
              <button onclick="ERPApp.openModal('markattendance')" class="bg-secondary text-on-secondary px-md py-xs rounded-xl text-xs font-semibold hover:bg-secondary-container">Mark Attendance</button>
            </div>

            <div class="flex items-center justify-between p-md rounded-xl border border-outline-variant bg-surface-container-low hover:border-secondary transition-all">
              <div class="flex items-center gap-md">
                <div class="w-12 h-12 rounded-xl bg-primary-container/10 text-primary flex flex-col items-center justify-center font-bold text-xs">
                  <span>10:15</span>
                  <span class="text-[10px]">AM</span>
                </div>
                <div>
                  <h4 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Honors Physics II</h4>
                  <p class="text-xs text-on-surface-variant">Room 302 • 32 Students • 18 Hostel Residents</p>
                </div>
              </div>
              <button onclick="ERPApp.openModal('lessonplan')" class="border border-outline text-on-surface px-md py-xs rounded-xl text-xs font-semibold hover:bg-surface-container-high">Lesson Plan</button>
            </div>
          </div>
        </div>

        <!-- Action Items & Hostel Sync -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
          <div class="lg:col-span-6 bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm">
            <h3 class="font-headline-md text-headline-md text-on-surface mb-md flex items-center gap-sm">
              <span class="material-symbols-outlined text-secondary">checklist</span> Action Items &amp; Grading
            </h3>
            <ul class="space-y-sm">
              <li class="flex items-start gap-md p-md rounded-xl bg-surface-container-low hover:bg-surface-container-high transition-all cursor-pointer">
                <span class="material-symbols-outlined text-error mt-0.5">assignment_late</span>
                <div>
                  <p class="font-body-md text-body-md font-semibold text-on-surface">Grade Midterm Lab Reports</p>
                  <p class="text-xs text-on-surface-variant">AP Physics C • 28 submissions pending review</p>
                </div>
              </li>
              <li class="flex items-start gap-md p-md rounded-xl bg-surface-container-low hover:bg-surface-container-high transition-all cursor-pointer">
                <span class="material-symbols-outlined text-error mt-0.5">person_off</span>
                <div>
                  <p class="font-body-md text-body-md font-semibold text-on-surface">Verify Unexcused Absence</p>
                  <p class="text-xs text-on-surface-variant">Marcus Johnson (Block B, Rm 204) • Unreported absence yesterday</p>
                </div>
              </li>
            </ul>
          </div>

          <div class="lg:col-span-6 bg-surface-container-lowest rounded-2xl border border-outline-variant p-lg shadow-sm">
            <h3 class="font-headline-md text-headline-md text-on-surface mb-md flex items-center gap-sm">
              <span class="material-symbols-outlined text-secondary">sync</span> Classroom-Hostel Sync Notifications
            </h3>
            <div class="space-y-sm text-body-sm">
              <div class="p-md rounded-xl bg-surface-container-low border border-outline-variant/40 flex items-start gap-sm">
                <span class="material-symbols-outlined text-error">local_hospital</span>
                <div>
                  <p class="font-medium text-on-surface"><span class="font-bold">Hostel Sick Leave</span> reported for Alex Rivera (Block A, Rm 102)</p>
                  <span class="text-xs text-outline">5 minutes ago</span>
                </div>
              </div>
              <div class="p-md rounded-xl bg-surface-container-low border border-outline-variant/40 flex items-start gap-sm">
                <span class="material-symbols-outlined text-secondary">flight_takeoff</span>
                <div>
                  <p class="font-medium text-on-surface"><span class="font-bold">Leave Clearance Request</span> from Emily Chen pending teacher endorsement</p>
                  <span class="text-xs text-outline">10 minutes ago</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
};
