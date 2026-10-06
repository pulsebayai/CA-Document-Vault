"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth/staff";
import { createClient } from "@/lib/supabase/server";
import { loadNotifications, type NotificationList } from "./queries";

// Feature 05 AC-13 / S4: opening the bell panel returns the newest 20 and marks them all read (the list keeps
// the "unread" flags as they were before opening, so the panel can show which are new).

export type OpenNotificationsResult = { ok: true; list: NotificationList } | { ok: false; error: string };

export async function openNotifications(): Promise<OpenNotificationsResult> {
  await requireStaff();
  let list: NotificationList;
  try {
    list = await loadNotifications();
  } catch {
    return { ok: false, error: "Couldn't load notifications. Please try again." };
  }
  if (list.unread > 0) {
    const supabase = await createClient();
    const { error } = await supabase.rpc("mark_notifications_read");
    if (error) console.error("notifications.mark_read_failed", { code: error.code ?? "unknown", requestId: randomUUID() });
    else revalidatePath("/", "layout");
  }
  return { ok: true, list };
}
