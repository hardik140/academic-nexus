/**
 * Academic Nexus — Database Type Definitions
 *
 * These types mirror the Supabase PostgreSQL schema (see supabase/migrations/).
 * In production, generate these automatically with:
 *   npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserRole =
  | "student"
  | "teacher"
  | "hod"
  | "finance"
  | "director"
  | "admin"
  | "warden"
  | "super_admin";

export type UserStatus = "active" | "suspended" | "pending" | "graduated" | "alumni";

/**
 * Loosens DB-enum (CHECK constraint) literal unions to plain `string` for
 * write payloads, since form state is naturally string-typed and Postgres
 * already enforces the constraint at the DB layer.
 */
type Widen<T> = {
  [K in keyof T]: T[K] extends unknown[]
    ? T[K]
    : null extends T[K]
      ? T[K] extends string | null
        ? string | null
        : T[K]
      : T[K] extends string
        ? string
        : T[K];
};

/**
 * An Insert type's required fields should match what Postgres actually
 * requires: any nullable column, or any column with a DB DEFAULT, may be
 * omitted on insert. This hand-maintained file previously required every
 * Row field on every Insert, which doesn't reflect that — fixed here for
 * every table (marking each table's nullable/defaulted columns optional)
 * rather than proper `supabase gen types` generation, which infers this
 * automatically from the live schema and remains the real long-term fix.
 */
type OptionalKeys<Row, K extends keyof Row> = Omit<Row, K> & Partial<Pick<Row, K>>;

export interface Database {
  public: {
    Tables: {
      colleges: {
        Row: {
          id: string;
          name: string;
          code: string;
          domain: string | null;
          logo_url: string | null;
          address: string | null;
          city: string | null;
          state: string | null;
          country: string | null;
          phone: string | null;
          email: string | null;
          website: string | null;
          accreditation: string | null;
          established_year: number | null;
          created_by: string | null;
          is_platform: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["colleges"]["Row"],
          "id" | "created_at" | "updated_at" | "domain" | "logo_url" | "address" | "city" | "state" | "country" | "phone" | "email" | "website" | "accreditation" | "established_year" | "created_by" | "is_platform"
        >;
        Update: Partial<Database["public"]["Tables"]["colleges"]["Insert"]>;
        Relationships: [];
      };

      profiles: {
        Row: {
          id: string;
          college_id: string;
          full_name: string;
          email: string;
          avatar_url: string | null;
          phone: string | null;
          role: UserRole;
          department_id: string | null;
          status: UserStatus;
          date_of_birth: string | null;
          gender: "male" | "female" | "other" | "prefer_not_to_say" | null;
          address: string | null;
          city: string | null;
          state: string | null;
          pincode: string | null;
          emergency_contact_name: string | null;
          emergency_contact_phone: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["profiles"]["Row"],
          "created_at" | "updated_at" | "avatar_url" | "phone" | "role" | "department_id" | "status" | "date_of_birth" | "gender" | "address" | "city" | "state" | "pincode" | "emergency_contact_name" | "emergency_contact_phone"
        >;
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };

      permissions: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          module: string;
        };
        Insert: OptionalKeys<Database["public"]["Tables"]["permissions"]["Row"], "id" | "description" | "module">;
        Update: Partial<Database["public"]["Tables"]["permissions"]["Insert"]>;
        Relationships: [];
      };

      role_permissions: {
        Row: {
          id: string;
          role: UserRole;
          permission_id: string;
          college_id: string;
          granted_by: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<Database["public"]["Tables"]["role_permissions"]["Row"], "id" | "created_at" | "granted_by">;
        Update: Partial<Database["public"]["Tables"]["role_permissions"]["Insert"]>;
        Relationships: [];
      };

      departments: {
        Row: {
          id: string;
          college_id: string;
          name: string;
          code: string;
          hod_id: string | null;
          description: string | null;
          established_year: number | null;
          status: "active" | "inactive";
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["departments"]["Row"],
          "id" | "created_at" | "updated_at" | "hod_id" | "description" | "established_year" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["departments"]["Insert"]>;
        Relationships: [];
      };

      courses: {
        Row: {
          id: string;
          college_id: string;
          department_id: string;
          name: string;
          code: string;
          credits: number;
          semester: number | null;
          year: number | null;
          type: "core" | "elective" | "lab" | "project" | "seminar";
          instructor_id: string | null;
          max_students: number | null;
          description: string | null;
          syllabus_url: string | null;
          status: "active" | "inactive" | "archived";
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["courses"]["Row"],
          "id" | "created_at" | "updated_at" | "semester" | "year" | "type" | "instructor_id" | "max_students" | "description" | "syllabus_url" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["courses"]["Insert"]>;
        Relationships: [];
      };

      semesters: {
        Row: {
          id: string;
          college_id: string;
          name: string;
          start_date: string;
          end_date: string;
          is_current: boolean;
          academic_year: string;
          created_at: string;
        };
        Insert: OptionalKeys<Database["public"]["Tables"]["semesters"]["Row"], "id" | "created_at" | "is_current">;
        Update: Partial<Database["public"]["Tables"]["semesters"]["Insert"]>;
        Relationships: [];
      };

      course_enrollments: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          course_id: string;
          semester_id: string | null;
          status: "enrolled" | "dropped" | "completed" | "failed";
          grade: string | null;
          grade_points: number | null;
          created_at: string;
        };
        Insert: OptionalKeys<Database["public"]["Tables"]["course_enrollments"]["Row"], "id" | "created_at" | "semester_id" | "status" | "grade" | "grade_points">;
        Update: Partial<Database["public"]["Tables"]["course_enrollments"]["Insert"]>;
        Relationships: [];
      };

      timetable_slots: {
        Row: {
          id: string;
          college_id: string;
          course_id: string;
          day_of_week: number;
          start_time: string;
          end_time: string;
          room: string | null;
          instructor_id: string | null;
          semester_id: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<Database["public"]["Tables"]["timetable_slots"]["Row"], "id" | "created_at" | "room" | "instructor_id" | "semester_id">;
        Update: Partial<Database["public"]["Tables"]["timetable_slots"]["Insert"]>;
        Relationships: [];
      };

      students: {
        Row: {
          id: string;
          college_id: string;
          user_id: string;
          department_id: string;
          enrollment_number: string;
          batch_year: number;
          semester: number;
          cgpa: number | null;
          credits_completed: number;
          credits_required: number;
          admission_date: string | null;
          status: "active" | "suspended" | "graduated" | "dropped" | "on_leave";
          parent_name: string | null;
          parent_phone: string | null;
          parent_email: string | null;
          blood_group: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["students"]["Row"],
          "id" | "created_at" | "updated_at" | "semester" | "cgpa" | "credits_completed" | "credits_required" | "status" | "admission_date" | "parent_name" | "parent_phone" | "parent_email" | "blood_group"
        >;
        Update: Partial<Database["public"]["Tables"]["students"]["Insert"]>;
        Relationships: [];
      };

      attendance: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          course_id: string;
          date: string;
          status: "present" | "absent" | "late" | "excused";
          marked_by: string;
          remarks: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<Database["public"]["Tables"]["attendance"]["Row"], "id" | "created_at" | "status" | "remarks">;
        Update: Partial<Database["public"]["Tables"]["attendance"]["Insert"]>;
        Relationships: [];
      };

      marks: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          course_id: string;
          exam_type: "internal_1" | "internal_2" | "midterm" | "final" | "assignment" | "lab" | "project" | "viva";
          max_marks: number;
          obtained_marks: number;
          semester: number | null;
          remarks: string | null;
          entered_by: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<Database["public"]["Tables"]["marks"]["Row"], "id" | "created_at" | "semester" | "remarks" | "entered_by">;
        Update: Partial<Database["public"]["Tables"]["marks"]["Insert"]>;
        Relationships: [];
      };

      fees: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          type: string;
          description: string | null;
          amount: number;
          due_date: string;
          status: "pending" | "paid" | "overdue" | "partial" | "waived" | "refunded";
          paid_amount: number;
          paid_at: string | null;
          semester: number | null;
          academic_year: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["fees"]["Row"],
          "id" | "created_at" | "updated_at" | "description" | "status" | "paid_amount" | "paid_at" | "semester" | "academic_year"
        >;
        Update: Partial<Database["public"]["Tables"]["fees"]["Insert"]>;
        Relationships: [];
      };

      payments: {
        Row: {
          id: string;
          college_id: string;
          fee_id: string;
          student_id: string;
          amount: number;
          method: "cash" | "card" | "upi" | "netbanking" | "cheque" | "dd" | "scholarship" | "other";
          transaction_ref: string | null;
          receipt_number: string | null;
          status: "cleared" | "pending" | "failed" | "refunded";
          processed_by: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["payments"]["Row"],
          "id" | "created_at" | "transaction_ref" | "receipt_number" | "status" | "processed_by" | "notes"
        >;
        Update: Partial<Database["public"]["Tables"]["payments"]["Insert"]>;
        Relationships: [];
      };

      scholarships: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          name: string;
          amount: number;
          type: "merit" | "need" | "sports" | "government" | "corporate" | "other";
          academic_year: string | null;
          status: "active" | "expired" | "revoked";
          awarded_date: string | null;
          expiry_date: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["scholarships"]["Row"],
          "id" | "created_at" | "academic_year" | "status" | "awarded_date" | "expiry_date"
        >;
        Update: Partial<Database["public"]["Tables"]["scholarships"]["Insert"]>;
        Relationships: [];
      };

      hostel_blocks: {
        Row: {
          id: string;
          college_id: string;
          name: string;
          type: "boys" | "girls" | "co-ed";
          warden_id: string | null;
          total_rooms: number;
          floors: number;
          status: "active" | "maintenance" | "closed";
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["hostel_blocks"]["Row"],
          "id" | "created_at" | "warden_id" | "total_rooms" | "floors" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["hostel_blocks"]["Insert"]>;
        Relationships: [];
      };

      hostel_rooms: {
        Row: {
          id: string;
          college_id: string;
          block_id: string;
          block_name: string;
          room_number: string;
          floor: number;
          capacity: number;
          occupancy: number;
          type: "single" | "double" | "triple" | "quad";
          ac: boolean;
          status: "available" | "full" | "maintenance";
          monthly_rent: number | null;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["hostel_rooms"]["Row"],
          "id" | "floor" | "capacity" | "occupancy" | "type" | "ac" | "status" | "monthly_rent"
        >;
        Update: Partial<Database["public"]["Tables"]["hostel_rooms"]["Insert"]>;
        Relationships: [];
      };

      hostel_allocations: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          room_id: string;
          allocated_date: string;
          vacated_date: string | null;
          status: "active" | "vacated" | "transferred";
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["hostel_allocations"]["Row"],
          "id" | "created_at" | "allocated_date" | "vacated_date" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["hostel_allocations"]["Insert"]>;
        Relationships: [];
      };

      gate_passes: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          destination: string;
          reason: string | null;
          exit_time: string;
          return_time: string;
          actual_exit: string | null;
          actual_return: string | null;
          status: "pending" | "approved" | "rejected" | "active" | "returned" | "expired";
          approved_by: string | null;
          approved_at: string | null;
          parent_notified: boolean;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["gate_passes"]["Row"],
          "id" | "created_at" | "reason" | "actual_exit" | "actual_return" | "status" | "approved_by" | "approved_at" | "parent_notified"
        >;
        Update: Partial<Database["public"]["Tables"]["gate_passes"]["Insert"]>;
        Relationships: [];
      };

      mess_menu: {
        Row: {
          id: string;
          college_id: string;
          day_of_week: number;
          meal_type: "breakfast" | "lunch" | "snacks" | "dinner";
          items: string[];
          calories: number | null;
          is_vegetarian: boolean;
          effective_from: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["mess_menu"]["Row"],
          "id" | "created_at" | "calories" | "is_vegetarian" | "effective_from"
        >;
        Update: Partial<Database["public"]["Tables"]["mess_menu"]["Insert"]>;
        Relationships: [];
      };

      complaints: {
        Row: {
          id: string;
          college_id: string;
          submitted_by: string;
          category: "plumbing" | "electrical" | "ac_hvac" | "carpentry" | "cleaning" | "internet" | "safety" | "ragging" | "academic" | "hostel" | "mess" | "other";
          title: string;
          description: string;
          location: string | null;
          priority: "low" | "medium" | "high" | "critical";
          status: "open" | "in_progress" | "resolved" | "closed" | "escalated";
          assigned_to: string | null;
          resolution_notes: string | null;
          resolved_at: string | null;
          attachment_urls: string[] | null;
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["complaints"]["Row"],
          "id" | "created_at" | "updated_at" | "location" | "priority" | "status" | "assigned_to" | "resolution_notes" | "resolved_at" | "attachment_urls"
        >;
        Update: Partial<Database["public"]["Tables"]["complaints"]["Insert"]>;
        Relationships: [];
      };

      events: {
        Row: {
          id: string;
          college_id: string;
          title: string;
          description: string | null;
          event_type: "academic" | "cultural" | "sports" | "workshop" | "seminar" | "placement" | "exam" | "holiday" | "other";
          start_date: string;
          end_date: string | null;
          venue: string | null;
          organizer_id: string | null;
          department_id: string | null;
          max_participants: number | null;
          registration_open: boolean;
          status: "upcoming" | "ongoing" | "completed" | "cancelled";
          banner_url: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["events"]["Row"],
          "id" | "created_at" | "description" | "end_date" | "venue" | "organizer_id" | "department_id" | "max_participants" | "registration_open" | "status" | "banner_url"
        >;
        Update: Partial<Database["public"]["Tables"]["events"]["Insert"]>;
        Relationships: [];
      };

      notifications: {
        Row: {
          id: string;
          college_id: string;
          title: string;
          message: string;
          receiver_id: string;
          sender_id: string | null;
          read: boolean;
          type: "info" | "warning" | "success" | "error" | "action_required";
          link: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["notifications"]["Row"],
          "id" | "created_at" | "sender_id" | "read" | "type" | "link"
        >;
        Update: Partial<Database["public"]["Tables"]["notifications"]["Insert"]>;
        Relationships: [];
      };

      audit_logs: {
        Row: {
          id: string;
          college_id: string;
          user_id: string;
          action: string;
          table_name: string;
          record_id: string | null;
          old_value: Json | null;
          new_value: Json | null;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["audit_logs"]["Row"],
          "id" | "created_at" | "record_id" | "old_value" | "new_value" | "ip_address" | "user_agent"
        >;
        Update: Partial<Database["public"]["Tables"]["audit_logs"]["Insert"]>;
        Relationships: [];
      };

      documents: {
        Row: {
          id: string;
          college_id: string;
          uploaded_by: string;
          name: string;
          file_url: string;
          file_size: number | null;
          mime_type: string | null;
          category: "certificate" | "marksheet" | "id_card" | "fee_receipt" | "application" | "notice" | "circular" | "other";
          related_to: string | null;
          status: "active" | "archived" | "deleted";
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["documents"]["Row"],
          "id" | "created_at" | "file_size" | "mime_type" | "related_to" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["documents"]["Insert"]>;
        Relationships: [];
      };

      leave_requests: {
        Row: {
          id: string;
          college_id: string;
          requested_by: string;
          leave_type: "casual" | "sick" | "earned" | "maternity" | "paternity" | "study" | "sabbatical" | "other";
          start_date: string;
          end_date: string;
          reason: string;
          status: "pending" | "approved" | "rejected" | "cancelled";
          approved_by: string | null;
          approved_at: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["leave_requests"]["Row"],
          "id" | "created_at" | "status" | "approved_by" | "approved_at"
        >;
        Update: Partial<Database["public"]["Tables"]["leave_requests"]["Insert"]>;
        Relationships: [];
      };

      library_books: {
        Row: {
          id: string;
          college_id: string;
          title: string;
          author: string;
          isbn: string | null;
          publisher: string | null;
          edition: string | null;
          category: string | null;
          total_copies: number;
          available_copies: number;
          shelf_location: string | null;
          cover_url: string | null;
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["library_books"]["Row"],
          "id" | "created_at" | "isbn" | "publisher" | "edition" | "category" | "total_copies" | "available_copies" | "shelf_location" | "cover_url"
        >;
        Update: Partial<Database["public"]["Tables"]["library_books"]["Insert"]>;
        Relationships: [];
      };

      library_issued: {
        Row: {
          id: string;
          college_id: string;
          book_id: string;
          issued_to: string;
          issued_date: string;
          due_date: string;
          returned_date: string | null;
          fine_amount: number;
          status: "issued" | "returned" | "overdue" | "lost";
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["library_issued"]["Row"],
          "id" | "created_at" | "issued_date" | "returned_date" | "fine_amount" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["library_issued"]["Insert"]>;
        Relationships: [];
      };

      transport_routes: {
        Row: {
          id: string;
          college_id: string;
          route_name: string;
          route_number: string | null;
          stops: string[];
          departure_time: string | null;
          arrival_time: string | null;
          vehicle_number: string | null;
          driver_name: string | null;
          driver_phone: string | null;
          capacity: number;
          status: "active" | "inactive";
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["transport_routes"]["Row"],
          "id" | "created_at" | "route_number" | "departure_time" | "arrival_time" | "vehicle_number" | "driver_name" | "driver_phone" | "capacity" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["transport_routes"]["Insert"]>;
        Relationships: [];
      };

      placements: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          company_name: string;
          role_title: string;
          package_lpa: number | null;
          placement_date: string | null;
          offer_type: "full_time" | "internship" | "ppo" | null;
          status: "placed" | "joined" | "declined" | "offer_revoked";
          created_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["placements"]["Row"],
          "id" | "created_at" | "package_lpa" | "placement_date" | "offer_type" | "status"
        >;
        Update: Partial<Database["public"]["Tables"]["placements"]["Insert"]>;
        Relationships: [];
      };

      device_tokens: {
        Row: {
          id: string;
          college_id: string;
          user_id: string;
          expo_push_token: string;
          platform: "ios" | "android";
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["device_tokens"]["Row"],
          "id" | "created_at" | "updated_at"
        >;
        Update: Partial<Database["public"]["Tables"]["device_tokens"]["Insert"]>;
        Relationships: [];
      };

      invitations: {
        Row: {
          id: string;
          college_id: string;
          email: string;
          role: UserRole;
          department_id: string | null;
          invited_by: string;
          user_id: string | null;
          status: "pending" | "accepted" | "revoked" | "expired";
          metadata: Json | null;
          token_hash: string | null;
          expires_at: string;
          accepted_at: string | null;
          accepted_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: OptionalKeys<
          Database["public"]["Tables"]["invitations"]["Row"],
          "id" | "department_id" | "user_id" | "status" | "metadata" | "token_hash" | "expires_at" | "accepted_at" | "accepted_by" | "created_at" | "updated_at"
        >;
        Update: Partial<Database["public"]["Tables"]["invitations"]["Insert"]>;
        Relationships: [];
      };
    };

    Views: {
      mv_attendance_summary: {
        Row: {
          college_id: string;
          department_id: string;
          course_id: string;
          course_name: string;
          course_code: string;
          present_count: number;
          late_count: number;
          absent_count: number;
          total_count: number;
          attendance_pct: number | null;
        };
        Relationships: [];
      };

      mv_fee_summary: {
        Row: {
          college_id: string;
          total_billed: number;
          total_collected: number;
          total_overdue: number | null;
          total_invoices: number;
          paid_invoices: number;
          overdue_invoices: number;
          collection_pct: number | null;
        };
        Relationships: [];
      };

      mv_department_enrollment: {
        Row: {
          college_id: string;
          department_id: string;
          department_name: string;
          department_code: string;
          total_students: number;
          active_students: number;
          avg_cgpa: number | null;
          avg_credits: number | null;
        };
        Relationships: [];
      };

      mv_placement_summary: {
        Row: {
          college_id: string;
          total_placed: number;
          total_companies: number;
          avg_package: number | null;
          max_package: number | null;
          min_package: number | null;
        };
        Relationships: [];
      };
    };

    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}

/** Helper: extract a table Row type */
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

/** Helper: extract a table Insert type */
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

/** Helper: extract a table Update type */
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];

/** Helper: extract a view Row type */
export type ViewRows<T extends keyof Database["public"]["Views"]> =
  Database["public"]["Views"][T]["Row"];
