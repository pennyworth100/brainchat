import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dimle",
  description: "Ephemeral rooms. No accounts. No history.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-dimle-bg text-dimle-text-primary antialiased font-sans">
        {children}
      </body>
    </html>
  );
}
