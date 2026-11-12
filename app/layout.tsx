import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HireMyAss — job prospect pooler",
  description:
    "Local-first job board aggregator. Reads your resume, pools matching openings, tracks what you applied to.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
