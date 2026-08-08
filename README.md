# Academic Nexus

Academic Nexus is a college management web application built with Next.js (App Router) and TypeScript, backed by Supabase (Postgres). It provides role-based portals and mobile API endpoints to manage students, faculty, hostels, fees, attendance, gate passes, events, and more.

## Key features
- Role-based portals: student, teacher, warden, admin
- Mobile-oriented API endpoints under `app/api/mobile/*`
- Supabase-backed Postgres schema with typed TypeScript definitions (see `types/database.ts`)
- Modules for user management, gatepasses, leave requests, fees, attendance, and other campus workflows

## Stack
- Language: TypeScript
- Framework: Next.js (App Router)
- Backend-as-a-Service: Supabase (Postgres + Auth + Storage)
- Database migrations: supabase/migrations (Postgres / PLpgSQL)
- Server-side code: `app/api` routes and server actions (see `app/(portal)/*/actions` modules)

## Repository layout (selected)
app/
  api/                     Next.js API routes (app Router). Mobile endpoints live under `app/api/mobile`.
  (portal)/                Role-specific application code (admin, student, teacher, warden)
types/
  database.ts              Generated-style TypeScript types matching the Supabase schema
lib/
  api-errors.ts            Shared API error handling (referenced by routes)
supabase/
  migrations/              Database migrations (referenced by types/database.ts)
public/
  ...                      Static assets (likely)
components/
  ...                      UI components (likely)

## Getting started (developer)
1. Clone
   git clone https://github.com/hardik140/academic-nexus.git
   cd academic-nexus

2. Install dependencies
   npm install
   # or
   pnpm install

3. Create an .env.local with these variables (example)
   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=public-anon-key
   SUPABASE_SERVICE_ROLE_KEY=service-role-key
   NEXTAUTH_URL=http://localhost:3000

4. Run locally
   npm run dev
   # or
   pnpm dev

5. Database migrations
   If you use the Supabase CLI:
   - Install Supabase CLI: https://supabase.com/docs/guides/cli
   - Run migrations: supabase db push
   See the `supabase/migrations` folder for schema files referenced by `types/database.ts`.

## Mobile API examples
The repository exposes mobile endpoints in `app/api/mobile/*`. Example handlers (server-side) call into role-specific actions:

- Create user (admin)
  POST /api/mobile/admin/create-user
  Body: { "email": "...", "fullName": "...", "role": "...", "departmentId": "..." }

- Apply for gate pass (student)
  POST /api/mobile/gatepass/apply
  Body: { "destination": "...", "reason": "...", "exitTime": "...", "returnTime": "..." }

- Act on gate pass (warden)
  POST /api/mobile/gatepass/act
  Body: { "passId": "...", "action": "approve|reject|..." }

- Apply for leave (teacher)
  POST /api/mobile/leave/apply
  Body: { "leaveType": "...", "startDate": "...", "endDate": "...", "reason": "..." }

(Refer to `app/api/mobile/*/route.ts` for server logic and `app/(portal)/*/actions` for implementations.)

## Development notes & conventions
- Types: `types/database.ts` mirrors the Supabase schema and provides strong typing for rows, inserts and updates.
- Server actions and API handlers use `NextResponse` and centralized error handling (`@/lib/api-errors`).
- When adding new DB columns, update Supabase migrations and regenerate `types/database.ts` with:
  ```
  npx supabase gen types typescript --project-id <your-project-id> > types/database.ts
  ```

## Contributing
1. Open an issue describing the change or bug.
2. Create a branch: `git checkout -b feat/short-description`
3. Run tests (if present) and add/update types for DB changes.
4. Create a PR describing the change.

## License
Specify license (e.g., MIT) here if applicable.

## Where to look next
- `types/database.ts` — DB schema types and reference for table fields
- `app/(portal)` — business logic and server-side actions per role
- `app/api/mobile` — mobile-oriented HTTP endpoints
- `supabase/migrations` — DB migrations and constraints
