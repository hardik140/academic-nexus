/**
 * Academic Nexus — Database Type Definitions
 *
 * These types mirror the Supabase PostgreSQL schema.
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
  | "parent";

export type UserStatus = "active" | "suspended" | "pending";

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
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["colleges"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["colleges"]["Insert"]>;
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
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["profiles"]["Row"], "created_at">;
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
      };

      permissions: {
        Row: {
          id: string;
          name: string;
          description: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["permissions"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["permissions"]["Insert"]>;
      };

      role_permissions: {
        Row: {
          id: string;
          role: UserRole;
          permission_id: string;
          college_id: string;
        };
        Insert: Omit<Database["public"]["Tables"]["role_permissions"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["role_permissions"]["Insert"]>;
      };

      departments: {
        Row: {
          id: string;
          college_id: string;
          name: string;
          code: string;
          hod_id: string | null;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["departments"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["departments"]["Insert"]>;
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
          instructor_id: string | null;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["courses"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["courses"]["Insert"]>;
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
          status: string;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["students"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["students"]["Insert"]>;
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
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["attendance"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["attendance"]["Insert"]>;
      };

      fees: {
        Row: {
          id: string;
          college_id: string;
          student_id: string;
          type: string;
          amount: number;
          due_date: string;
          status: "pending" | "paid" | "overdue" | "partial";
          paid_amount: number;
          paid_at: string | null;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["fees"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["fees"]["Insert"]>;
      };

      payments: {
        Row: {
          id: string;
          college_id: string;
          fee_id: string;
          student_id: string;
          amount: number;
          method: string;
          transaction_ref: string;
          status: "cleared" | "pending" | "failed" | "refunded";
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["payments"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["payments"]["Insert"]>;
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
          actual_return: string | null;
          status: "pending" | "approved" | "rejected" | "active" | "returned";
          approved_by: string | null;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["gate_passes"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["gate_passes"]["Insert"]>;
      };

      hostel_rooms: {
        Row: {
          id: string;
          college_id: string;
          block_name: string;
          room_number: string;
          capacity: number;
          occupancy: number;
          type: "single" | "double" | "triple";
          ac: boolean;
          status: "available" | "full" | "maintenance";
        };
        Insert: Omit<Database["public"]["Tables"]["hostel_rooms"]["Row"], "id">;
        Update: Partial<Database["public"]["Tables"]["hostel_rooms"]["Insert"]>;
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
          type: string;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["notifications"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["notifications"]["Insert"]>;
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
        Insert: Omit<Database["public"]["Tables"]["audit_logs"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["audit_logs"]["Insert"]>;
      };

      complaints: {
        Row: {
          id: string;
          college_id: string;
          submitted_by: string;
          category: string;
          title: string;
          description: string;
          location: string | null;
          status: "open" | "in_progress" | "resolved" | "closed";
          assigned_to: string | null;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["complaints"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["complaints"]["Insert"]>;
      };
    };

    Views: {
      attendance_summary: {
        Row: {
          college_id: string;
          department_id: string;
          course_id: string;
          present_count: number;
          total_count: number;
          attendance_pct: number;
        };
      };

      fee_summary: {
        Row: {
          college_id: string;
          total_billed: number;
          total_collected: number;
          total_overdue: number;
          collection_pct: number;
        };
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
