import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Branch360 | Enterprise Branch Analytics", description: "Branch performance and SLA operations dashboard" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
