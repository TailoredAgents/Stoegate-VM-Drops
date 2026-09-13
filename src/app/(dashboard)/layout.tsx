import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  return <AppShell email={user.email}>{children}</AppShell>;
}
