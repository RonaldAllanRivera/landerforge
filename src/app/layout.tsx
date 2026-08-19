import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LanderForge",
  description: "Constraint-driven advertorial copy generation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
