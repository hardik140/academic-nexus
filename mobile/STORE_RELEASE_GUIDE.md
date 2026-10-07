# Academic Nexus Mobile Release Guide (Play Store + App Store)

This document is the end-to-end execution guide to publish the mobile app from this repository:

- Mobile app root: `/home/runner/work/academic-nexus/academic-nexus/mobile`
- Backend/web root: `/home/runner/work/academic-nexus/academic-nexus`

---

## 1) One-time accounts and access

Create and verify:

1. Google Play Console account
2. Apple Developer Program account
3. Expo account (EAS)
4. Supabase production project
5. Cloudflare account/project access for production deployment

Also ensure at least two team members have owner/admin access for release continuity.

---

## 2) Production backend deployment (must be done first)

The mobile app depends on `/api/mobile/*` endpoints hosted by the web app. Reviewers on Play/App Store cannot validate the app unless this backend is live.

### 2.1 Configure production environment

Use `/home/runner/work/academic-nexus/academic-nexus/.env.local.example` as the checklist for required server variables.

Minimum production-critical variables include:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `GATE_QR_SIGNING_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `QSTASH_URL`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`
- SMTP variables if invitations/password-reset emails are required

### 2.2 Deploy to Cloudflare

From `/home/runner/work/academic-nexus/academic-nexus`:

1. Install dependencies: `npm ci`
2. Sync worker secrets as needed: `npm run cf:secrets`
3. Deploy: `npm run deploy`

### 2.3 Validate backend readiness

Confirm:

1. Production URL is HTTPS.
2. Login works from browser.
3. Mobile API endpoints respond from production domain.
4. Supabase auth/session flow works against production values.

---

## 3) Mobile production configuration

### 3.1 App identity already configured

In `/home/runner/work/academic-nexus/academic-nexus/mobile/app.json`:

- iOS bundle identifier: `edu.academicnexus.app`
- Android package: `edu.academicnexus.app`

### 3.2 Environment variables for app runtime

Use `/home/runner/work/academic-nexus/academic-nexus/mobile/.env.example`:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_API_BASE_URL` (production backend URL)
- `EXPO_PUBLIC_SENTRY_DSN` (optional but recommended)

For EAS cloud builds, configure these in Expo EAS environment for the target profile/environment.

### 3.3 EAS build profiles

`/home/runner/work/academic-nexus/academic-nexus/mobile/eas.json` defines:

- `development`
- `preview`
- `production`

`production` uses auto-incrementing app versions during build.

---

## 4) Build signed binaries

From `/home/runner/work/academic-nexus/academic-nexus/mobile`:

1. Install dependencies: `npm ci`
2. Login to Expo: `npx eas login`
3. Initialize EAS project (first time only): `npm run eas:configure`
4. Build Android release AAB: `npm run build:android:production`
5. Build iOS release IPA: `npm run build:ios:production`

Use EAS-managed credentials unless your organization requires manual keystore/certificate management.

---

## 5) Pre-submission QA checklist

Run on real Android and iOS devices using production backend:

1. Sign in and role-based navigation works
2. Core flows work (attendance, grading, leave, gate pass, complaints, finance, director actions)
3. Push token registration works
4. Announcement notifications are delivered
5. No crash loops on startup/login
6. Sentry receives errors (if DSN configured)

Do not submit if any blocker flow fails in production mode.

---

## 6) Store assets and compliance package

Prepare once and keep versioned in your release workspace:

1. App title/subtitle/short description/full description
2. Privacy Policy public URL
3. Support email and support URL
4. Store screenshots (all required screen sizes)
5. App icon (store-grade) and Play feature graphic
6. Data safety/privacy answers (based on actual data collection)
7. Reviewer/demo account credentials and steps

---

## 7) Google Play release flow

1. Create app in Play Console.
2. Complete Store Listing.
3. Complete App Content/Data Safety/Permissions declarations.
4. Upload AAB to Internal testing first.
5. Validate with internal testers.
6. Promote to closed/open testing if needed.
7. Roll out to production with staged rollout.

After production launch:

1. Monitor crashes/ANRs.
2. Monitor ratings/reviews.
3. Halt rollout if critical issues appear.

---

## 8) Apple App Store release flow

1. Create app record in App Store Connect.
2. Verify bundle ID matches `edu.academicnexus.app`.
3. Upload IPA build from EAS.
4. Start TestFlight internal testing, then external testing if needed.
5. Complete App Privacy and metadata.
6. Add App Review notes with demo credentials and flow.
7. Submit for App Review.
8. Release manually or automatically after approval.

---

## 9) Submission notes for reviewer access

Because this app is role-based and login-gated, include in both stores:

1. Test account credentials
2. Role of each credential
3. Exact test steps for each role
4. Any OTP/magic-link dependencies
5. Contact person for reviewer issues

Without this, reviews are often delayed or rejected as "unable to access app features."

---

## 10) Release operations after launch

For every new release:

1. Validate backend compatibility.
2. Confirm env vars are correct.
3. Bump versions/build numbers (auto-increment configured for production profile).
4. Run smoke tests on real devices.
5. Submit to internal track/TestFlight first.
6. Promote to production gradually.
7. Monitor observability dashboards for at least 24-48 hours.

---

## 11) Useful commands (mobile)

Run from `/home/runner/work/academic-nexus/academic-nexus/mobile`:

- `npm run lint`
- `npm run test`
- `npm run build:android:preview`
- `npm run build:ios:preview`
- `npm run build:android:production`
- `npm run build:ios:production`
- `npm run submit:android:production`
- `npm run submit:ios:production`

---

## 12) Go-live order (recommended)

1. Deploy backend production
2. Configure EAS env values
3. Build Android + iOS production binaries
4. Run internal QA
5. Submit Play + App Store with reviewer credentials
6. Launch in phased rollout
7. Monitor and stabilize

