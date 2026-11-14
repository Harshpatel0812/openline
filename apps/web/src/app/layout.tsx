import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Openline", template: "%s · Openline" },
  description:
    "The outreach CRM that keeps you out of spam, out of trouble, and true to your word.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers makes every page render per request, which lets Next.js attach the
  // CSP nonce from middleware.ts to its scripts.
  await headers();
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
