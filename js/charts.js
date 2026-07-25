// Academic Nexus — SVG Charting & Analytics Engine
const ERPCharts = {
  
  // 1. Institutional Trends Chart (Director 360 View)
  renderDirectorTrendChart: function() {
    return `
      <div class="w-full h-64 flex flex-col justify-between p-md relative overflow-hidden bg-surface-container-low/50 rounded-xl border border-outline-variant/50">
        <!-- SVG Grid Background -->
        <svg class="absolute inset-0 w-full h-full opacity-15" preserveAspectRatio="none" viewBox="0 0 500 200">
          <line x1="0" y1="40" x2="500" y2="40" stroke="#76777d" stroke-dasharray="4"/>
          <line x1="0" y1="80" x2="500" y2="80" stroke="#76777d" stroke-dasharray="4"/>
          <line x1="0" y1="120" x2="500" y2="120" stroke="#76777d" stroke-dasharray="4"/>
          <line x1="0" y1="160" x2="500" y2="160" stroke="#76777d" stroke-dasharray="4"/>
        </svg>

        <!-- Dynamic Data Trend Lines -->
        <svg class="w-full h-48 relative z-10" preserveAspectRatio="none" viewBox="0 0 500 160">
          <!-- Area Gradient -->
          <defs>
            <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#0051d5" stop-opacity="0.3"/>
              <stop offset="100%" stop-color="#0051d5" stop-opacity="0.0"/>
            </linearGradient>
          </defs>

          <!-- Area Fill -->
          <polygon points="0,140 0,100 80,85 160,95 240,60 320,40 400,30 500,20 500,160 0,160" fill="url(#chartGrad)" />

          <!-- Line 1: Enrollment Growth -->
          <polyline fill="none" stroke="#0051d5" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" points="0,100 80,85 160,95 240,60 320,40 400,30 500,20" />
          
          <!-- Line 2: Revenue Target -->
          <polyline fill="none" stroke="#059669" stroke-width="2.5" stroke-dasharray="6" stroke-linecap="round" points="0,110 80,95 160,90 240,75 320,55 400,45 500,35" />

          <!-- Interactive Data Points -->
          <circle cx="80" cy="85" r="5" fill="#0051d5" class="hover:r-7 transition-all cursor-pointer"><title>Q1: 10,200 Students</title></circle>
          <circle cx="160" cy="95" r="5" fill="#0051d5" class="hover:r-7 transition-all cursor-pointer"><title>Q2: 10,800 Students</title></circle>
          <circle cx="240" cy="60" r="5" fill="#0051d5" class="hover:r-7 transition-all cursor-pointer"><title>Q3: 11,500 Students</title></circle>
          <circle cx="320" cy="40" r="5" fill="#0051d5" class="hover:r-7 transition-all cursor-pointer"><title>Q4: 12,100 Students</title></circle>
          <circle cx="500" cy="20" r="6" fill="#0051d5" stroke="#ffffff" stroke-width="2" class="hover:r-8 transition-all cursor-pointer"><title>Current: 12,450 Students (+4.2%)</title></circle>
        </svg>

        <!-- X-Axis Labels -->
        <div class="flex justify-between items-center text-[11px] font-mono-code text-on-surface-variant pt-xs border-t border-outline-variant/40 relative z-10">
          <span>Fall 2021</span>
          <span>Spring 2022</span>
          <span>Fall 2022</span>
          <span>Spring 2023</span>
          <span>Fall 2023</span>
          <span class="text-secondary font-bold">Fall 2024 (Current)</span>
        </div>
      </div>
    `;
  },

  // 2. Receivables & Collection Donut Gauge (Finance Portal)
  renderFinanceGauge: function(collectedPct = 68) {
    const circumference = 2 * Math.PI * 40;
    const strokeDashoffset = circumference - (collectedPct / 100) * circumference;

    return `
      <div class="flex items-center gap-md">
        <div class="relative w-28 h-28 flex items-center justify-center shrink-0">
          <svg class="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="40" stroke="#e2e8f0" stroke-width="10" fill="transparent"/>
            <circle cx="50" cy="50" r="40" stroke="#0051d5" stroke-width="10" fill="transparent"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${strokeDashoffset}"
                    stroke-linecap="round"
                    class="transition-all duration-1000"/>
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span class="font-display-lg text-lg font-bold text-primary">${collectedPct}%</span>
            <span class="text-[9px] uppercase font-semibold text-on-surface-variant">Collected</span>
          </div>
        </div>
        <div>
          <p class="font-headline-sm font-bold text-on-surface">$4,250,000 Total Cleared</p>
          <p class="text-xs text-on-surface-variant mt-0.5">Target: $6,250,000 for Fall Semester 2024</p>
          <div class="mt-sm flex items-center gap-xs text-xs font-semibold text-emerald-600">
            <span class="material-symbols-outlined text-[16px]">trending_up</span> On track for Q4 closure
          </div>
        </div>
      </div>
    `;
  },

  // 3. Hostel Occupancy Distribution Chart (Warden Portal)
  renderHostelOccupancyBar: function() {
    return `
      <div class="space-y-sm">
        <div class="space-y-xs">
          <div class="flex justify-between text-xs font-medium text-on-surface">
            <span>Boys Hostel Block B (AC)</span>
            <span class="font-mono-code font-bold">240 / 250 Rooms (96%)</span>
          </div>
          <div class="w-full bg-surface-container h-2.5 rounded-full overflow-hidden">
            <div class="bg-secondary h-full rounded-full" style="width: 96%"></div>
          </div>
        </div>

        <div class="space-y-xs">
          <div class="flex justify-between text-xs font-medium text-on-surface">
            <span>Girls Hostel Block A (AC)</span>
            <span class="font-mono-code font-bold">180 / 190 Rooms (94.7%)</span>
          </div>
          <div class="w-full bg-surface-container h-2.5 rounded-full overflow-hidden">
            <div class="bg-secondary h-full rounded-full" style="width: 94.7%"></div>
          </div>
        </div>

        <div class="space-y-xs">
          <div class="flex justify-between text-xs font-medium text-on-surface">
            <span>International Hostel Block C</span>
            <span class="font-mono-code font-bold">50 / 60 Rooms (83.3%)</span>
          </div>
          <div class="w-full bg-surface-container h-2.5 rounded-full overflow-hidden">
            <div class="bg-secondary h-full rounded-full" style="width: 83.3%"></div>
          </div>
        </div>
      </div>
    `;
  }
};
