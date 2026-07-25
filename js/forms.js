// Academic Nexus — Interactive Web Form Engine
const WebForms = {

  // Main Web Forms Hub Interface
  hub: function(activeForm = 'admission') {
    return `
      <div class="space-y-lg animate-fade-in">
        <!-- Form Navigation Header -->
        <div class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-md mb-md">
            <div>
              <span class="badge-status badge-info mb-xs">Institutional Web Forms Portal</span>
              <h1 class="font-display-lg text-display-lg text-on-surface">Academic Web Forms Hub</h1>
              <p class="font-body-lg text-body-lg text-on-surface-variant">Official institutional web forms for student admission, course registration, gate passes, fee billing, and hostel requests.</p>
            </div>
          </div>

          <!-- Web Form Navigation Tabs -->
          <div class="flex flex-wrap gap-xs pt-md border-t border-outline-variant/60">
            <button onclick="ERPApp.showWebForm('admission')" class="px-md py-sm rounded-full font-label-md text-xs font-semibold transition-all ${activeForm === 'admission' ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}">
              📝 Student Admission
            </button>
            <button onclick="ERPApp.showWebForm('course')" class="px-md py-sm rounded-full font-label-md text-xs font-semibold transition-all ${activeForm === 'course' ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}">
              📚 Course Enrollment
            </button>
            <button onclick="ERPApp.showWebForm('gatepass')" class="px-md py-sm rounded-full font-label-md text-xs font-semibold transition-all ${activeForm === 'gatepass' ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}">
              🚪 Gate Pass Application
            </button>
            <button onclick="ERPApp.showWebForm('feepay')" class="px-md py-sm rounded-full font-label-md text-xs font-semibold transition-all ${activeForm === 'feepay' ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}">
              💳 Fee Payment &amp; Receipt
            </button>
            <button onclick="ERPApp.showWebForm('faculty')" class="px-md py-sm rounded-full font-label-md text-xs font-semibold transition-all ${activeForm === 'faculty' ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}">
              👨‍🏫 Faculty Onboarding
            </button>
            <button onclick="ERPApp.showWebForm('hostel')" class="px-md py-sm rounded-full font-label-md text-xs font-semibold transition-all ${activeForm === 'hostel' ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}">
              🏢 Hostel Allotment
            </button>
            <button onclick="ERPApp.showWebForm('maintenance')" class="px-md py-sm rounded-full font-label-md text-xs font-semibold transition-all ${activeForm === 'maintenance' ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high'}">
              🛠️ Maintenance Request
            </button>
          </div>
        </div>

        <!-- Render Selected Form -->
        <div id="webFormRenderArea" class="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg shadow-sm">
          ${this.renderFormContent(activeForm)}
        </div>
      </div>
    `;
  },

  renderFormContent: function(formId) {
    switch(formId) {
      case 'admission': return this.renderAdmissionForm();
      case 'course': return this.renderCourseEnrollmentForm();
      case 'gatepass': return this.renderGatePassForm();
      case 'feepay': return this.renderFeePaymentForm();
      case 'faculty': return this.renderFacultyForm();
      case 'hostel': return this.renderHostelForm();
      case 'maintenance': return this.renderMaintenanceForm();
      default: return this.renderAdmissionForm();
    }
  },

  // 1. Student Admission Web Form
  renderAdmissionForm: function() {
    return `
      <form onsubmit="event.preventDefault(); ERPApp.submitWebForm('Student Admission');" class="space-y-lg animate-fade-in max-w-4xl mx-auto">
        <div class="border-b border-outline-variant pb-md">
          <h2 class="font-headline-md text-headline-md text-on-surface font-bold flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">assignment_ind</span> Official Student Admission Web Form
          </h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Academic Year 2024–2025 • New Student Registration</p>
        </div>

        <!-- Section 1: Personal Details -->
        <fieldset class="space-y-md border border-outline-variant/60 rounded-xl p-md bg-surface-container-low/40">
          <legend class="px-sm font-label-md text-secondary font-bold uppercase text-xs">Section 1: Applicant Personal Information</legend>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div>
              <label class="block font-label-md text-on-surface-variant mb-xs">First Name *</label>
              <input type="text" required placeholder="Alex" class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
            </div>
            <div>
              <label class="block font-label-md text-on-surface-variant mb-xs">Last Name *</label>
              <input type="text" required placeholder="Mercer" class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
            </div>
            <div>
              <label class="block font-label-md text-on-surface-variant mb-xs">Date of Birth *</label>
              <input type="date" required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
            <div>
              <label class="block font-label-md text-on-surface-variant mb-xs">Email Address *</label>
              <input type="email" required placeholder="alex.mercer@student.edu" class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
            </div>
            <div>
              <label class="block font-label-md text-on-surface-variant mb-xs">Phone Number *</label>
              <input type="tel" required placeholder="+1 (555) 234-5678" class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
            </div>
          </div>
        </fieldset>

        <!-- Section 2: Academic Program Selection -->
        <fieldset class="space-y-md border border-outline-variant/60 rounded-xl p-md bg-surface-container-low/40">
          <legend class="px-sm font-label-md text-secondary font-bold uppercase text-xs">Section 2: Academic Program &amp; Major</legend>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
            <div>
              <label class="block font-label-md text-on-surface-variant mb-xs">Department / Major *</label>
              <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
                <option value="cs">Computer Science &amp; Engineering</option>
                <option value="ee">Electrical Engineering</option>
                <option value="me">Mechanical Engineering</option>
                <option value="arts">Arts &amp; Humanities</option>
                <option value="bus">Business Administration</option>
              </select>
            </div>
            <div>
              <label class="block font-label-md text-on-surface-variant mb-xs">Degree Level *</label>
              <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
                <option value="bachelor">Bachelor of Science (B.S.)</option>
                <option value="master">Master of Science (M.S.)</option>
                <option value="phd">Doctor of Philosophy (Ph.D.)</option>
              </select>
            </div>
          </div>
        </fieldset>

        <!-- Form Submission Button -->
        <div class="flex justify-end gap-sm pt-md border-t border-outline-variant">
          <button type="reset" class="px-lg py-md border border-outline-variant rounded-xl font-label-md hover:bg-surface-container-low">Reset Form</button>
          <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container shadow-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-[18px]">send</span> Submit Admission Form
          </button>
        </div>
      </form>
    `;
  },

  // 2. Course Enrollment Form
  renderCourseEnrollmentForm: function() {
    return `
      <form onsubmit="event.preventDefault(); ERPApp.submitWebForm('Course Enrollment');" class="space-y-lg animate-fade-in max-w-4xl mx-auto">
        <div class="border-b border-outline-variant pb-md">
          <h2 class="font-headline-md text-headline-md text-on-surface font-bold flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">menu_book</span> Course Enrollment &amp; Registration Web Form
          </h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Select required core &amp; elective courses for Fall Semester 2024.</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Student ID Number</label>
            <input type="text" value="STU-2024-8841" readonly class="w-full bg-surface-container-high border border-outline-variant rounded-xl p-md text-body-md font-mono-code font-bold"/>
          </div>
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Academic Term</label>
            <input type="text" value="Fall Semester 2024" readonly class="w-full bg-surface-container-high border border-outline-variant rounded-xl p-md text-body-md font-semibold"/>
          </div>
        </div>

        <!-- Course Picker List -->
        <div class="space-y-sm">
          <label class="block font-label-md text-on-surface-variant mb-xs">Select Courses to Register:</label>
          
          <div class="p-md bg-surface-container-low rounded-xl border border-outline-variant flex items-center justify-between">
            <div class="flex items-center gap-md">
              <input type="checkbox" checked disabled class="w-5 h-5 text-secondary rounded focus:ring-secondary"/>
              <div>
                <p class="font-headline-sm font-bold text-on-surface">CS-301: Advanced Data Structures &amp; Algorithms</p>
                <p class="text-xs text-on-surface-variant">Core Requirement • 4 Credits • Dr. Alan Turing</p>
              </div>
            </div>
            <span class="badge-status badge-success">Core Enrolled</span>
          </div>

          <div class="p-md bg-surface-container-low rounded-xl border border-outline-variant flex items-center justify-between">
            <div class="flex items-center gap-md">
              <input type="checkbox" checked class="w-5 h-5 text-secondary rounded focus:ring-secondary"/>
              <div>
                <p class="font-headline-sm font-bold text-on-surface">PHY-202: Quantum Mechanics &amp; Optics Lab</p>
                <p class="text-xs text-on-surface-variant">Science Elective • 3 Credits • Prof. M. Curie</p>
              </div>
            </div>
            <span class="badge-status badge-info">3 Credits</span>
          </div>

          <div class="p-md bg-surface-container-low rounded-xl border border-outline-variant flex items-center justify-between">
            <div class="flex items-center gap-md">
              <input type="checkbox" checked class="w-5 h-5 text-secondary rounded focus:ring-secondary"/>
              <div>
                <p class="font-headline-sm font-bold text-on-surface">CS-450: Machine Learning &amp; AI Neural Nets</p>
                <p class="text-xs text-on-surface-variant">Departmental Elective • 4 Credits • Dr. Lee</p>
              </div>
            </div>
            <span class="badge-status badge-info">4 Credits</span>
          </div>
        </div>

        <div class="flex justify-end gap-sm pt-md border-t border-outline-variant">
          <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container shadow-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-[18px]">check_circle</span> Confirm Course Registration
          </button>
        </div>
      </form>
    `;
  },

  // 3. Gate Pass Web Form
  renderGatePassForm: function() {
    return `
      <form onsubmit="event.preventDefault(); ERPApp.submitWebForm('Gate Pass Request');" class="space-y-lg animate-fade-in max-w-4xl mx-auto">
        <div class="border-b border-outline-variant pb-md">
          <h2 class="font-headline-md text-headline-md text-on-surface font-bold flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">directions_walk</span> Out-of-Campus Gate Pass Web Application Form
          </h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Submit for Warden &amp; Security clearance prior to leaving campus.</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Student Full Name *</label>
            <input type="text" value="Alex Mercer" required class="w-full bg-surface-container-low border border-outline-variant rounded-xl p-md text-body-md font-semibold"/>
          </div>
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Hostel Block &amp; Room No *</label>
            <input type="text" value="Block B, Room 402" required class="w-full bg-surface-container-low border border-outline-variant rounded-xl p-md text-body-md font-semibold"/>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Expected Exit Date &amp; Time *</label>
            <input type="datetime-local" required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
          </div>
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Expected Return Date &amp; Time *</label>
            <input type="datetime-local" required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
          </div>
        </div>

        <div>
          <label class="block font-label-md text-on-surface-variant mb-xs">Destination &amp; Reason for Leave *</label>
          <textarea required rows="3" placeholder="e.g. Visiting medical center in city for checkup..." class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"></textarea>
        </div>

        <div class="flex justify-end gap-sm pt-md border-t border-outline-variant">
          <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container shadow-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-[18px]">verified</span> Submit Gate Pass Application
          </button>
        </div>
      </form>
    `;
  },

  // 4. Fee Payment Form
  renderFeePaymentForm: function() {
    return `
      <form onsubmit="event.preventDefault(); ERPApp.submitWebForm('Fee Payment');" class="space-y-lg animate-fade-in max-w-4xl mx-auto">
        <div class="border-b border-outline-variant pb-md">
          <h2 class="font-headline-md text-headline-md text-on-surface font-bold flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">payments</span> Fee Payment &amp; Billing Web Form
          </h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Process tuition fees, hostel dues, and generate instant digital receipt.</p>
        </div>

        <div class="bg-error-container/30 border border-error/20 p-md rounded-xl flex justify-between items-center">
          <div>
            <p class="font-label-md text-error uppercase font-semibold">Current Outstanding Term Dues</p>
            <p class="font-display-lg text-display-lg text-error font-mono-code font-bold">$1,250.00</p>
          </div>
          <span class="badge-status badge-danger">Due: Nov 15, 2024</span>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Select Payment Category *</label>
            <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
              <option value="tuition">Tuition &amp; Examination Fees ($1,250)</option>
              <option value="hostel">Hostel Accommodation Deposit ($300)</option>
              <option value="mess">Mess &amp; Dining Monthly Bill ($185)</option>
            </select>
          </div>
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Payment Method *</label>
            <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
              <option value="card">Credit / Debit Card (Stripe / Razorpay)</option>
              <option value="netbanking">Net Banking Transfer</option>
              <option value="upi">UPI / Mobile Wallet</option>
            </select>
          </div>
        </div>

        <div class="flex justify-end gap-sm pt-md border-t border-outline-variant">
          <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container shadow-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-[18px]">credit_card</span> Pay &amp; Generate Digital Receipt
          </button>
        </div>
      </form>
    `;
  },

  // 5. Faculty Onboarding Form
  renderFacultyForm: function() {
    return `
      <form onsubmit="event.preventDefault(); ERPApp.submitWebForm('Faculty Onboarding');" class="space-y-lg animate-fade-in max-w-4xl mx-auto">
        <div class="border-b border-outline-variant pb-md">
          <h2 class="font-headline-md text-headline-md text-on-surface font-bold flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">person_add</span> Faculty &amp; Staff Onboarding Web Form
          </h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Register new professor, instructor, or administrative staff account.</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Full Name *</label>
            <input type="text" required placeholder="Dr. Alan Turing" class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
          </div>
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Institutional Designation *</label>
            <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
              <option value="prof">Professor</option>
              <option value="assoc">Associate Professor</option>
              <option value="hod">Head of Department (HOD)</option>
              <option value="warden">Hostel Warden</option>
              <option value="admin">System Administrator</option>
            </select>
          </div>
        </div>

        <div class="flex justify-end gap-sm pt-md border-t border-outline-variant">
          <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container shadow-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-[18px]">person_add</span> Complete Faculty Onboarding
          </button>
        </div>
      </form>
    `;
  },

  // 6. Hostel Allotment Form
  renderHostelForm: function() {
    return `
      <form onsubmit="event.preventDefault(); ERPApp.submitWebForm('Hostel Allotment');" class="space-y-lg animate-fade-in max-w-4xl mx-auto">
        <div class="border-b border-outline-variant pb-md">
          <h2 class="font-headline-md text-headline-md text-on-surface font-bold flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">apartment</span> Hostel Room Allotment Web Form
          </h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Apply for campus residence block and room preference.</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Hostel Block Preference *</label>
            <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
              <option value="b">Boys Hostel Block B (AC / Double)</option>
              <option value="a">Girls Hostel Block A (AC / Single)</option>
              <option value="c">International Hostel Block C</option>
            </select>
          </div>
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Dietary Preference *</label>
            <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
              <option value="veg">Vegetarian Mess</option>
              <option value="nonveg">Non-Vegetarian Mess</option>
              <option value="vegan">Vegan / Special Diet</option>
            </select>
          </div>
        </div>

        <div class="flex justify-end gap-sm pt-md border-t border-outline-variant">
          <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container shadow-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-[18px]">home</span> Submit Room Application
          </button>
        </div>
      </form>
    `;
  },

  // 7. Maintenance Request Form
  renderMaintenanceForm: function() {
    return `
      <form onsubmit="event.preventDefault(); ERPApp.submitWebForm('Maintenance Request');" class="space-y-lg animate-fade-in max-w-4xl mx-auto">
        <div class="border-b border-outline-variant pb-md">
          <h2 class="font-headline-md text-headline-md text-on-surface font-bold flex items-center gap-sm">
            <span class="material-symbols-outlined text-secondary">build</span> Maintenance &amp; Complaint Web Form
          </h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Report campus infrastructure, plumbing, AC, or electrical maintenance issues.</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-md">
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Issue Category *</label>
            <select required class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none">
              <option value="plumbing">Plumbing / Leaky Tap</option>
              <option value="electrical">Electrical / Light Failure</option>
              <option value="ac">AC Cooling / Ventilation</option>
              <option value="carpentry">Furniture / Lock Failure</option>
            </select>
          </div>
          <div>
            <label class="block font-label-md text-on-surface-variant mb-xs">Location / Room Number *</label>
            <input type="text" required placeholder="e.g. Block B, Room 402" class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"/>
          </div>
        </div>

        <div>
          <label class="block font-label-md text-on-surface-variant mb-xs">Detailed Problem Description *</label>
          <textarea required rows="3" placeholder="Describe the issue clearly..." class="w-full bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-body-md focus:ring-2 focus:ring-secondary outline-none"></textarea>
        </div>

        <div class="flex justify-end gap-sm pt-md border-t border-outline-variant">
          <button type="submit" class="px-lg py-md bg-secondary text-on-secondary rounded-xl font-label-md font-semibold hover:bg-secondary-container shadow-sm flex items-center gap-sm">
            <span class="material-symbols-outlined text-[18px]">handyman</span> Log Maintenance Ticket
          </button>
        </div>
      </form>
    `;
  }
};
