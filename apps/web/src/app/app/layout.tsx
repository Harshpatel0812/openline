import type { ReactNode } from "react";
import { AppShell } from "@/components/app/app-shell";
import { MeProvider } from "@/components/app/me-context";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <MeProvider>
      <AppShell>{children}</AppShell>
    </MeProvider>
  );
}
