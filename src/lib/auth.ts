import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { compare } from "bcryptjs";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";

export const SESSION_COOKIE = "sg_vm_session";

function tokenHash(token: string) {
  return createHmac("sha256", getEnv().SESSION_SECRET)
    .update(token)
    .digest("hex");
}

export async function authenticate(email: string, password: string) {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!user?.active || !(await compare(password, user.passwordHash)))
    return null;
  return user;
}

export async function createSession(userId: string) {
  const env = getEnv();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  );
  await db.session.create({
    data: { tokenHash: tokenHash(token), userId, expiresAt },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token)
    await db.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  store.delete(SESSION_COOKIE);
}

export async function getCurrentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt <= new Date() || !session.user.active)
    return null;
  return session.user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireApiUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}
