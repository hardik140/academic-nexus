import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Academic Nexus — Enterprise SIS & College ERP",
  description:
    "Multi-tenant SaaS Student Information System & College ERP Platform. Manage admissions, attendance, fees, hostel, placements, and more.",
  keywords: [
    "college erp",
    "student information system",
    "sis",
    "academic management",
    "multi-tenant saas",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-background text-on-background antialiased">
        {children}
      </body>
    </html>
  );
}
