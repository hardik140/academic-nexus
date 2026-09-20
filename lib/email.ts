/**
 * Email sending module — Cloudflare Workers compatible.
 *
 * `nodemailer` relies on raw TCP sockets (`node:net`, `node:tls`) which are
 * unavailable on Cloudflare Workers. This module dynamically imports
 * nodemailer only when running on Node.js. On Workers the send functions
 * log a warning and silently no-op — the app keeps working, just without
 * email delivery until a future migration to an HTTP-based provider
 * (Resend, SendGrid, etc.).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transporter: any = null;

/**
 * True when running on a full Node.js runtime (Vercel, local dev, CI).
 * False on Cloudflare Workers.
 */
function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

/**
 * Lazily-built SMTP transport. Only works on Node.js — throws when SMTP
 * is unconfigured, and the caller already guards on `isNodeRuntime()`.
 */
async function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!host || !port || !user || !pass) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASSWORD in .env.local."
    );
  }

  // Dynamic import so the bundler doesn't pull nodemailer into the
  // Workers bundle where it would crash at import time.
  const nodemailer = (await import("nodemailer")).default;

  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: { user, pass },
  });
  return transporter;
}

function fromAddress(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@academic-nexus.local";
}

const ROLE_LABELS: Record<string, string> = {
  student: "Student",
  teacher: "Teacher",
  hod: "HOD",
  finance: "Finance",
  director: "Director",
  admin: "College Admin",
  warden: "Warden",
  super_admin: "Super Admin",
  placement_cell: "Placement Cell",
};

export async function sendInvitationEmail(params: {
  to: string;
  fullName: string;
  role: string;
  collegeName: string;
  actionLink: string;
}) {
  if (!isNodeRuntime()) {
    console.warn("[email] sendInvitationEmail no-op: nodemailer is unavailable on Cloudflare Workers");
    return;
  }

  const roleLabel = ROLE_LABELS[params.role] ?? params.role;
  const t = await getTransporter();

  await t.sendMail({
    from: fromAddress(),
    to: params.to,
    subject: `You've been invited to Academic Nexus`,
    html: `
      <p>Hi ${params.fullName},</p>
      <p>You've been invited to join <strong>${params.collegeName}</strong> as <strong>${roleLabel}</strong> on Academic Nexus.</p>
      <p><a href="${params.actionLink}">Accept your invitation</a> and set up your account.</p>
      <p>This link expires in 7 days. If you weren't expecting this invitation, you can ignore this email.</p>
    `,
  });
}

export async function sendPasswordResetEmail(params: { to: string; actionLink: string }) {
  if (!isNodeRuntime()) {
    console.warn("[email] sendPasswordResetEmail no-op: nodemailer is unavailable on Cloudflare Workers");
    return;
  }

  const t = await getTransporter();

  await t.sendMail({
    from: fromAddress(),
    to: params.to,
    subject: "Reset your Academic Nexus password",
    html: `
      <p>Click the link below to set a new password for your Academic Nexus account.</p>
      <p><a href="${params.actionLink}">Reset your password</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}
