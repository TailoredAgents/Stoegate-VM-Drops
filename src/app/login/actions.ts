"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticate, createSession, destroySession } from "@/lib/auth";

const loginSchema = z.object({ email: z.email(), password: z.string().min(1) });

export async function loginAction(formData: FormData) {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/login?error=invalid");
  const user = await authenticate(parsed.data.email, parsed.data.password);
  if (!user) redirect("/login?error=invalid");
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
