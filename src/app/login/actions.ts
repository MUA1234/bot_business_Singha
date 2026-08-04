"use server";

import { redirect } from "next/navigation";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase/server";
import { usernameToEmail } from "@/lib/constants";
import { homePathFor } from "@/lib/departments";

export interface LoginState {
  error?: string;
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "Enter your username and password." };

  const supabase = supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: usernameToEmail(username),
    password,
  });
  if (error || !data.user) return { error: "Incorrect username or password." };

  const { data: profile } = await supabaseAdmin()
    .from("profiles")
    .select("department, is_active")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile || !profile.is_active) {
    await supabase.auth.signOut();
    return { error: "This account is not active. Contact your administrator." };
  }

  redirect(homePathFor(profile.department));
}

export async function signOut(): Promise<void> {
  await supabaseServer().auth.signOut();
  redirect("/login");
}
