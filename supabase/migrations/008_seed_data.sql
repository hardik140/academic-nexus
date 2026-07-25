-- ============================================================
-- Migration 008: Seed Data
-- Demo college, departments, courses, users
-- ============================================================

-- Demo College
INSERT INTO public.colleges (id, name, code, domain, city, state, country, established_year)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'National Institute of Technology, Demo',
  'NIT-DEMO',
  'demo.academicnexus.edu',
  'Bangalore',
  'Karnataka',
  'India',
  2024
) ON CONFLICT (id) DO NOTHING;

-- Departments
INSERT INTO public.departments (id, college_id, name, code) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Computer Science & Engineering', 'CSE'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Electronics & Communication', 'ECE'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Mechanical Engineering', 'ME'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Civil Engineering', 'CE'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Electrical Engineering', 'EE'),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'Mathematics', 'MATH'),
  ('10000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'Physics', 'PHY'),
  ('10000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'Business Administration', 'MBA')
ON CONFLICT DO NOTHING;

-- Courses (CSE department)
INSERT INTO public.courses (id, college_id, department_id, name, code, credits, semester, type) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Data Structures & Algorithms', 'CS201', 4, 3, 'core'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Database Management Systems', 'CS301', 4, 5, 'core'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Operating Systems', 'CS302', 4, 5, 'core'),
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Computer Networks', 'CS401', 3, 7, 'core'),
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Machine Learning', 'CS451', 3, 7, 'elective'),
  ('20000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Web Development', 'CS352', 3, 6, 'elective'),
  ('20000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Compiler Design', 'CS402', 3, 7, 'core'),
  ('20000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Software Engineering', 'CS351', 3, 6, 'core')
ON CONFLICT DO NOTHING;

-- Courses (ECE department)
INSERT INTO public.courses (college_id, department_id, name, code, credits, semester, type) VALUES
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'Digital Signal Processing', 'EC301', 4, 5, 'core'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'VLSI Design', 'EC401', 3, 7, 'core'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'Embedded Systems', 'EC351', 3, 6, 'elective')
ON CONFLICT DO NOTHING;

-- Courses (ME department)
INSERT INTO public.courses (college_id, department_id, name, code, credits, semester, type) VALUES
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'Thermodynamics', 'ME201', 4, 3, 'core'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'Fluid Mechanics', 'ME301', 4, 5, 'core'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'Robotics', 'ME451', 3, 7, 'elective')
ON CONFLICT DO NOTHING;

-- Semesters
INSERT INTO public.semesters (college_id, name, start_date, end_date, is_current, academic_year) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Fall 2026', '2026-08-01', '2026-12-15', true, '2026-27'),
  ('00000000-0000-0000-0000-000000000001', 'Spring 2027', '2027-01-10', '2027-05-30', false, '2026-27')
ON CONFLICT DO NOTHING;

-- Permissions
INSERT INTO public.permissions (name, description, module) VALUES
  ('student.read', 'View student records', 'students'),
  ('student.write', 'Create/edit student records', 'students'),
  ('attendance.read', 'View attendance records', 'attendance'),
  ('attendance.write', 'Mark attendance', 'attendance'),
  ('fees.read', 'View fee records', 'finance'),
  ('fees.write', 'Create/manage fee invoices', 'finance'),
  ('fees.approve', 'Approve fee payments', 'finance'),
  ('grades.read', 'View grades', 'grades'),
  ('grades.write', 'Enter/modify grades', 'grades'),
  ('gatepass.read', 'View gate pass requests', 'hostel'),
  ('gatepass.approve', 'Approve/reject gate passes', 'hostel'),
  ('complaints.read', 'View complaints', 'operations'),
  ('complaints.manage', 'Assign and resolve complaints', 'operations'),
  ('users.read', 'View user accounts', 'admin'),
  ('users.write', 'Create/edit user accounts', 'admin'),
  ('roles.manage', 'Manage role permissions', 'admin'),
  ('audit.read', 'View audit logs', 'admin'),
  ('analytics.read', 'View analytics dashboards', 'analytics'),
  ('documents.read', 'View documents', 'documents'),
  ('documents.write', 'Upload documents', 'documents'),
  ('leave.request', 'Submit leave requests', 'leave'),
  ('leave.approve', 'Approve leave requests', 'leave'),
  ('hostel.manage', 'Manage hostel allocations', 'hostel'),
  ('library.manage', 'Manage library operations', 'library'),
  ('placement.read', 'View placement data', 'placements'),
  ('placement.manage', 'Manage placement records', 'placements')
ON CONFLICT (name) DO NOTHING;

-- Hostel blocks
INSERT INTO public.hostel_blocks (college_id, name, type, total_rooms, floors) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Tagore Hall', 'boys', 120, 4),
  ('00000000-0000-0000-0000-000000000001', 'Kalpana Chawla Hall', 'girls', 100, 4),
  ('00000000-0000-0000-0000-000000000001', 'Raman Hall', 'boys', 80, 3)
ON CONFLICT DO NOTHING;

-- Mess menu
INSERT INTO public.mess_menu (college_id, day_of_week, meal_type, items, calories, is_vegetarian) VALUES
  ('00000000-0000-0000-0000-000000000001', 1, 'breakfast', ARRAY['Idli', 'Sambar', 'Chutney', 'Tea/Coffee'], 350, true),
  ('00000000-0000-0000-0000-000000000001', 1, 'lunch', ARRAY['Rice', 'Dal', 'Paneer Butter Masala', 'Roti', 'Salad'], 650, true),
  ('00000000-0000-0000-0000-000000000001', 1, 'dinner', ARRAY['Chapati', 'Mix Veg', 'Dal Fry', 'Rice', 'Kheer'], 600, true),
  ('00000000-0000-0000-0000-000000000001', 2, 'breakfast', ARRAY['Poha', 'Boiled Eggs', 'Bread Butter', 'Milk'], 380, false),
  ('00000000-0000-0000-0000-000000000001', 2, 'lunch', ARRAY['Biryani', 'Raita', 'Chicken Curry', 'Salad'], 700, false),
  ('00000000-0000-0000-0000-000000000001', 2, 'dinner', ARRAY['Paratha', 'Chole', 'Rice', 'Pickle', 'Ice Cream'], 620, true)
ON CONFLICT DO NOTHING;

-- Transport routes
INSERT INTO public.transport_routes (college_id, route_name, route_number, stops, departure_time, arrival_time, capacity) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Majestic - Campus', 'R1', ARRAY['Majestic', 'Rajajinagar', 'Yeshwanthpur', 'Campus'], '07:30', '08:30', 50),
  ('00000000-0000-0000-0000-000000000001', 'Electronic City - Campus', 'R2', ARRAY['Electronic City', 'Silk Board', 'BTM Layout', 'Campus'], '07:00', '08:15', 45),
  ('00000000-0000-0000-0000-000000000001', 'Whitefield - Campus', 'R3', ARRAY['Whitefield', 'Marathahalli', 'Hebbal', 'Campus'], '07:15', '08:30', 40)
ON CONFLICT DO NOTHING;

-- Library books
INSERT INTO public.library_books (college_id, title, author, isbn, publisher, category, total_copies, available_copies) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Introduction to Algorithms', 'Cormen, Leiserson, Rivest, Stein', '978-0262033848', 'MIT Press', 'Computer Science', 15, 8),
  ('00000000-0000-0000-0000-000000000001', 'Design Patterns', 'Gang of Four', '978-0201633610', 'Addison-Wesley', 'Computer Science', 10, 6),
  ('00000000-0000-0000-0000-000000000001', 'Engineering Mechanics', 'R.C. Hibbeler', '978-0133915426', 'Pearson', 'Mechanical', 12, 9),
  ('00000000-0000-0000-0000-000000000001', 'Signals and Systems', 'Oppenheim, Willsky', '978-0138147570', 'Pearson', 'Electronics', 8, 5),
  ('00000000-0000-0000-0000-000000000001', 'Fundamentals of Database Systems', 'Elmasri, Navathe', '978-0133970777', 'Pearson', 'Computer Science', 10, 7)
ON CONFLICT DO NOTHING;
