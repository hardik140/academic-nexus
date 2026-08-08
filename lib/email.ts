import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | null = null;

/**
 * Lazily-built SMTP transport. Throws only when an email actually needs to
 * be sent and SMTP isn't configured yet — never at import time — so the
 * rest of the app keeps working even before real SMTP credentials exist,
 * same "ships inert until configured" posture as Sentry (see lib/../next.config.ts).
 */
function getTransporter(): Transporter {
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
};

export async function sendInvitationEmail(params: {
  to: string;
  fullName: string;
  role: string;
  collegeName: string;
  actionLink: string;
}) {
  const roleLabel = ROLE_LABELS[params.role] ?? params.role;

  await getTransporter().sendMail({
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
  await getTransporter().sendMail({
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
