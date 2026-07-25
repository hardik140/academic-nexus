// Academic Nexus - Master Production SaaS Application Engine
const ERPApp = {
  currentRole: 'student',
  currentViewMode: 'portal', // 'portal' or 'forms'
  activeWebForm: 'admission',
  isDarkMode: false,
  apiBase: 'http://localhost:3000/api',

  init: async function() {
    this.renderHeader();
    this.renderSidebar();
    this.renderCurrentView();
    this.attachEventListeners();
    await this.fetchBackendData();
    console.log("Academic Nexus Master SaaS Platform Engine initialized.");
  },

  // Fetch live state from backend REST API
  fetchBackendData: async function() {
    try {
      const [passesRes, txnsRes, logsRes, annRes] = await Promise.allSettled([
        fetch(`${this.apiBase}/gatepasses`),
        fetch(`${this.apiBase}/transactions`),
        fetch(`${this.apiBase}/auditlogs`),
        fetch(`${this.apiBase}/announcements`)
      ]);

      if (passesRes.status === 'fulfilled' && passesRes.value.ok) {
        ERP_DATA.gatePasses = await passesRes.value.json();
      }
      if (txnsRes.status === 'fulfilled' && txnsRes.value.ok) {
        ERP_DATA.transactions = await txnsRes.value.json();
      }
      if (logsRes.status === 'fulfilled' && logsRes.value.ok) {
        ERP_DATA.auditLogs = await logsRes.value.json();
      }
      if (annRes.status === 'fulfilled' && annRes.value.ok) {
        ERP_DATA.announcements = await annRes.value.json();
      }

      this.renderCurrentView();
    } catch (err) {
      console.warn("Backend REST API offline or unreachable; operating on local state mode.", err);
    }
  },

  // Switch between Dashboard Portals and Web Form Hub
  setViewMode: function(mode) {
    this.currentViewMode = mode;
    this.renderCurrentView();
    this.showToast(mode === 'forms' ? "Switched to Web Form Portal" : "Switched to ERP Dashboard Portal", "info");
  },

  showWebForm: function(formId) {
    this.currentViewMode = 'forms';
    this.activeWebForm = formId;
    this.renderCurrentView();
  },

  // Submit any Web Form
  submitWebForm: async function(formName) {
    this.showToast(`Web Form '${formName}' submitted successfully!`, "success");
    
    // Create an audit trail record
    const auditEntry = {
      time: "Just now",
      user: ERP_DATA.currentUser.name,
      roleBadge: ERP_DATA.currentUser.role.substring(0,2).toUpperCase(),
      action: `Submitted web form '${formName}'`
    };
    ERP_DATA.auditLogs.unshift(auditEntry);

    try {
      await fetch(`${this.apiBase}/auditlogs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(auditEntry)
      });
    } catch (err) {
      console.warn("API offline fallback", err);
    }
  },

  // Role switching controller
  switchRole: function(roleId) {
    if (!Portals[roleId]) return;
    this.currentRole = roleId;
    this.currentViewMode = 'portal';
    
    const roleInfo = ERP_DATA.roles.find(r => r.id === roleId);
    if (roleInfo) {
      ERP_DATA.currentUser.role = roleId;
      ERP_DATA.currentUser.name = roleInfo.userName;
      ERP_DATA.currentUser.avatar = roleInfo.avatar;
    }

    this.renderSidebar();
    this.renderHeader();
    this.renderCurrentView();
    this.showToast(`Switched to ${roleInfo.name} Portal view`, "info");
    
    const sidebar = document.getElementById('sidebarDrawer');
    if (sidebar) sidebar.classList.add('hidden');
  },

  renderCurrentView: function() {
    const mainContainer = document.getElementById('mainContentCanvas');
    if (!mainContainer) return;

    if (this.currentViewMode === 'forms') {
      mainContainer.innerHTML = WebForms.hub(this.activeWebForm);
    } else if (Portals[this.currentRole]) {
      mainContainer.innerHTML = Portals[this.currentRole]();
    }
  },

  renderHeader: function() {
    const roleObj = ERP_DATA.roles.find(r => r.id === this.currentRole);
    const roleTitleEl = document.getElementById('headerPortalTitle');
    const userAvatarEl = document.getElementById('headerUserAvatar');
    const userNameEl = document.getElementById('headerUserName');
    
    if (roleTitleEl) {
      roleTitleEl.innerText = this.currentViewMode === 'forms' 
        ? 'Institutional Web Forms Portal' 
        : (roleObj ? roleObj.label : 'Academic Nexus SIS');
    }
    if (userAvatarEl) userAvatarEl.src = ERP_DATA.currentUser.avatar;
    if (userNameEl) userNameEl.innerText = ERP_DATA.currentUser.name;
  },

  renderSidebar: function() {
    const navList = document.getElementById('sidebarNavList');
    if (!navList) return;

    navList.innerHTML = ERP_DATA.roles.map(r => `
      <li>
        <button onclick="ERPApp.switchRole('${r.id}')" class="w-full flex items-center gap-md px-md py-sm rounded-full mx-2 font-body-md text-body-md transition-all text-left ${this.currentViewMode === 'portal' && this.currentRole === r.id ? 'bg-secondary-fixed text-on-secondary-fixed font-bold shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high'}">
          <span class="material-symbols-outlined text-[20px]">${r.icon}</span>
          <span>${r.name}</span>
        </button>
      </li>
    `).join('');
  },

  // Export CSV Data Generator
  exportTableCSV: function(filename, dataArray) {
    if (!dataArray || !dataArray.length) {
      this.showToast("No data available to export", "error");
      return;
    }
    const headers = Object.keys(dataArray[0]).join(',');
    const rows = dataArray.map(obj => Object.values(obj).map(val => `"${val}"`).join(',')).join('\n');
    const csvContent = "data:text/csv;charset=utf-8," + headers + "\n" + rows;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${filename.toLowerCase().replace(/\s+/g, '_')}_export.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    this.showToast(`Exported ${filename} as CSV file!`, "success");
  },

  // Printable Digital Fee Receipt Modal
  printReceipt: function(txnId) {
    const txn = ERP_DATA.transactions.find(t => t.id === txnId) || { id: txnId, date: "Oct 24, 2024", student: "Sarah Jenkins", amount: "$4,500.00", type: "Tuition Payment", status: "CLEARED" };
    const container = document.getElementById('modalContentContainer');
    const backdrop = document.getElementById('modalBackdrop');
    if (!backdrop || !container) return;

    container.innerHTML = `
      <div class="p-lg space-y-md">
        <div class="flex justify-between items-start border-b border-outline-variant pb-md">
          <div>
            <h3 class="font-display-lg text-lg font-bold text-secondary">Academic Nexus University</h3>
            <p class="text-xs text-on-surface-variant">Official Financial Fee Receipt</p>
          </div>
          <button onclick="ERPApp.closeModal()" class="text-outline hover:text-on-surface no-print"><span class="material-symbols-outlined">close</span></button>
        </div>
        <div class="bg-surface-container-low p-md rounded-xl space-y-xs font-mono-code text-xs border border-outline-variant/60">
          <div class="flex justify-between"><span>Receipt ID:</span> <span class="font-bold text-primary">${txn.id}</span></div>
          <div class="flex justify-between"><span>Date:</span> <span>${txn.date}</span></div>
          <div class="flex justify-between"><span>Student:</span> <span class="font-bold">${txn.student}</span></div>
          <div class="flex justify-between"><span>Payment Type:</span> <span>${txn.type}</span></div>
          <div class="flex justify-between border-t border-outline-variant pt-xs text-sm font-bold"><span>Amount Paid:</span> <span class="text-emerald-600">${txn.amount}</span></div>
          <div class="flex justify-between"><span>Status:</span> <span class="badge-status badge-success">${txn.status}</span></div>
        </div>
        <div class="pt-md flex justify-end gap-sm no-print">
          <button onclick="ERPApp.closeModal()" class="px-lg py-md border border-outline-variant rounded-xl font-label-md">Close</button>
          <button onclick="window.print()" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container flex items-center gap-xs">
            <span class="material-symbols-outlined text-[18px]">print</span> Print Official Receipt
          </button>
        </div>
      </div>
    `;
    backdrop.classList.remove('hidden');
  },

  // Global Table Search
  handleGlobalSearch: function(query) {
    if (!query) return;
    const q = query.toLowerCase();
    const rows = document.querySelectorAll('tbody tr');
    rows.forEach(r => {
      const text = r.innerText.toLowerCase();
      r.style.display = text.includes(q) ? '' : 'none';
    });
  },

  toggleNotifications: function() {
    const panel = document.getElementById('notificationsPanel');
    if (panel) {
      panel.classList.toggle('hidden');
    }
  },

  toggleTheme: function() {
    this.isDarkMode = !this.isDarkMode;
    if (this.isDarkMode) {
      document.documentElement.classList.add('dark');
      this.showToast("Dark Mode activated", "info");
    } else {
      document.documentElement.classList.remove('dark');
      this.showToast("Light Mode activated", "info");
    }
  },

  // Modal Manager
  openModal: function(modalType) {
    const backdrop = document.getElementById('modalBackdrop');
    const container = document.getElementById('modalContentContainer');
    if (!backdrop || !container) return;

    let modalHTML = '';

    switch(modalType) {
      case 'gatepass':
        modalHTML = `
          <div class="p-lg">
            <div class="flex justify-between items-center mb-md border-b border-outline-variant pb-sm">
              <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">directions_walk</span> Out-of-Campus Gate Pass Web Form
              </h3>
              <button onclick="ERPApp.closeModal()" class="text-outline hover:text-on-surface"><span class="material-symbols-outlined">close</span></button>
            </div>
            <form onsubmit="event.preventDefault(); ERPApp.submitGatePass();" class="space-y-md">
              <div>
                <label class="block font-label-md text-on-surface-variant mb-xs">Destination Purpose</label>
                <input type="text" id="gpDest" required placeholder="e.g. City Center / Hospital Visit" class="w-full bg-surface-container-low border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
              </div>
              <div class="grid grid-cols-2 gap-md">
                <div>
                  <label class="block font-label-md text-on-surface-variant mb-xs">Expected Exit Time</label>
                  <input type="datetime-local" id="gpExit" required class="w-full bg-surface-container-low border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
                </div>
                <div>
                  <label class="block font-label-md text-on-surface-variant mb-xs">Expected Return Time</label>
                  <input type="datetime-local" id="gpReturn" required class="w-full bg-surface-container-low border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
                </div>
              </div>
              <div class="pt-md flex justify-end gap-sm">
                <button type="button" onclick="ERPApp.closeModal()" class="px-lg py-md border border-outline-variant rounded-xl font-label-md hover:bg-surface-container-low">Cancel</button>
                <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container">Submit Web Form</button>
              </div>
            </form>
          </div>
        `;
        break;

      case 'payfee':
        modalHTML = `
          <div class="p-lg">
            <div class="flex justify-between items-center mb-md border-b border-outline-variant pb-sm">
              <h3 class="font-headline-md text-headline-md text-on-surface flex items-center gap-sm">
                <span class="material-symbols-outlined text-secondary">payments</span> Fee Payment Web Form
              </h3>
              <button onclick="ERPApp.closeModal()" class="text-outline hover:text-on-surface"><span class="material-symbols-outlined">close</span></button>
            </div>
            <div class="bg-surface-container-low p-md rounded-xl mb-md border border-outline-variant/50">
              <p class="font-label-md text-on-surface-variant uppercase">Outstanding Tuition &amp; Hostel Balance</p>
              <p class="font-display-lg text-display-lg text-error font-mono-code font-bold">$1,250.00</p>
            </div>
            <form onsubmit="event.preventDefault(); ERPApp.processFeePayment();" class="space-y-md">
              <div>
                <label class="block font-label-md text-on-surface-variant mb-xs">Payment Method</label>
                <select id="payMethod" class="w-full bg-surface-container-low border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
                  <option value="card">Credit / Debit Card (Razorpay / Stripe)</option>
                  <option value="netbanking">Net Banking (Institutional Portal)</option>
                  <option value="upi">UPI / Digital Wallet</option>
                </select>
              </div>
              <div>
                <label class="block font-label-md text-on-surface-variant mb-xs">Amount to Pay ($)</label>
                <input type="number" id="payAmount" value="1250" max="1250" required class="w-full bg-surface-container-low border border-outline-variant rounded-xl p-md text-body-md font-mono-code focus:ring-2 focus:ring-secondary outline-none"/>
              </div>
              <div class="pt-md flex justify-end gap-sm">
                <button type="button" onclick="ERPApp.closeModal()" class="px-lg py-md border border-outline-variant rounded-xl font-label-md hover:bg-surface-container-low">Cancel</button>
                <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container">Submit Payment</button>
              </div>
            </form>
          </div>
        `;
        break;

      default:
        modalHTML = `
          <div class="p-lg text-center space-y-md">
            <span class="material-symbols-outlined text-secondary text-5xl">task_alt</span>
            <h3 class="font-headline-md text-headline-md text-on-surface">Web Form Submitted</h3>
            <p class="text-body-md text-on-surface-variant">Your web form data for ${modalType} has been processed successfully.</p>
            <button onclick="ERPApp.closeModal()" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold">Close Dialog</button>
          </div>
        `;
    }

    container.innerHTML = modalHTML;
    backdrop.classList.remove('hidden');
  },

  closeModal: function() {
    const backdrop = document.getElementById('modalBackdrop');
    if (backdrop) backdrop.classList.add('hidden');
  },

  // REST API Handlers for modal submissions
  submitGatePass: async function() {
    const dest = document.getElementById('gpDest').value;
    try {
      const res = await fetch(`${this.apiBase}/gatepasses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: dest })
      });
      if (res.ok) {
        const data = await res.json();
        ERP_DATA.gatePasses.unshift(data.gatePass);
      }
    } catch (err) {
      console.warn("API offline; updating local state", err);
      ERP_DATA.gatePasses.unshift({
        id: `GP-${107 + ERP_DATA.gatePasses.length}`,
        student: ERP_DATA.currentUser.name,
        room: "Block B-402",
        destination: dest,
        exit: "Oct 24, 18:00",
        return: "Oct 24, 21:00",
        status: "APPROVED",
        warden: "H. Vance"
      });
    }
    this.closeModal();
    this.renderCurrentView();
    this.showToast("Gate Pass web form submitted!", "success");
  },

  approveGatePass: async function(id) {
    try {
      await fetch(`${this.apiBase}/gatepasses/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'APPROVED' })
      });
    } catch (err) {
      console.warn("API offline; updating local state", err);
    }
    const item = ERP_DATA.gatePasses.find(g => g.id === id);
    if (item) item.status = "APPROVED";
    this.renderCurrentView();
    this.showToast(`Gate Pass ${id} approved!`, "success");
  },

  processFeePayment: async function() {
    const amount = document.getElementById('payAmount').value;
    try {
      const res = await fetch(`${this.apiBase}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amount, type: 'Fee Payment' })
      });
      if (res.ok) {
        const data = await res.json();
        ERP_DATA.transactions.unshift(data.transaction);
      }
    } catch (err) {
      console.warn("API offline; updating local state", err);
      ERP_DATA.transactions.unshift({
        id: `TX-${9022 + ERP_DATA.transactions.length}`,
        date: "Just now",
        student: ERP_DATA.currentUser.name,
        sid: "STU-2024",
        type: "Fee Payment",
        amount: `+$${amount}.00`,
        status: "CLEARED",
        badge: "badge-success"
      });
    }
    this.closeModal();
    this.renderCurrentView();
    this.showToast(`Payment web form submitted ($${amount}.00)!`, "success");
  },

  // Toast Notifications
  showToast: function(msg, type = "info") {
    const toast = document.createElement('div');
    const colorClass = type === 'success' ? 'bg-emerald-600 text-white' : type === 'error' ? 'bg-rose-600 text-white' : 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900';
    toast.className = `fixed bottom-6 right-6 z-50 px-lg py-md rounded-xl shadow-2xl font-body-sm font-semibold flex items-center gap-sm animate-fade-in ${colorClass}`;
    toast.innerHTML = `
      <span class="material-symbols-outlined text-[20px]">${type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info'}</span>
      <span>${msg}</span>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3500);
  },

  attachEventListeners: function() {
    window.addEventListener('click', (e) => {
      const notifBtn = document.getElementById('notifToggleBtn');
      const notifPanel = document.getElementById('notificationsPanel');
      if (notifPanel && !notifPanel.contains(e.target) && notifBtn && !notifBtn.contains(e.target)) {
        notifPanel.classList.add('hidden');
      }
    });
  }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  ERPApp.init();
});
