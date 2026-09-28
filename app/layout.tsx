import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Self-hosted by next/font: the files are downloaded at build time and served
 * from this deployment, so the browser never contacts Google (the old <link>
 * tags also fell outside the CSP's font-src/style-src). Only the approved
 * weights are loaded — Inter 400–700 and JetBrains Mono 400/500 — and each is
 * exposed as a CSS variable that app/globals.css maps onto --font-sans /
 * --font-mono.
 */
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-inter",
});

// Identifiers, reference numbers and codes only — not body copy. Not
// preloaded: most pages show none, so it loads only where it is used.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  preload: false,
  variable: "--font-jetbrains-mono",
});

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
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-background text-on-background antialiased">
        {children}
      </body>
    </html>
  );
}
