/**
 * Browser Notification shim for Pearly alerts (spec §1: works while the PWA
 * is open; service-worker Web Push is deferred). Fire-and-forget: native
 * notifications only when the tab is HIDDEN — the in-app ticker covers the
 * visible case. All decision logic lives in pearlyAlerts.ts (tested); this
 * file is a thin, untested DOM adapter by design.
 */
import type { PearlyAlert } from "./pearlyAlerts.ts";

export const notificationsSupported = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

export const notificationsEnabled = (): boolean =>
  notificationsSupported() && Notification.permission === "granted";

/** Ask once, from a user gesture (the 🔔 button). Resolves to the new state. */
export async function requestNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/** Fire native notifications for fresh alerts — hidden tab only. */
export function pushNotifications(alerts: PearlyAlert[]): void {
  if (!notificationsEnabled() || document.visibilityState !== "hidden") return;
  for (const a of alerts) {
    try {
      new Notification("Streak · Daily Pearly", { body: a.text, tag: a.id, icon: "/pwa-192x192.png" });
    } catch {
      // Android Chrome / iOS throw "Illegal constructor" in page context
      // (notifications are SW-only there) — mobile gets native push only when
      // Web Push lands; the in-app ticker covers those users.
    }
  }
}
