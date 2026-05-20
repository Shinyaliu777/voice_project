/**
 * Thin wrapper around the browser Notification API. Used by Recorder
 * (录音转写完成) and GenerateMinutesButton (AI 总结生成完成).
 *
 * The user.settings.desktopNotifications flag is the gate; permission
 * grant is its precondition. Both must be true for a notification to
 * actually appear — we silently no-op otherwise so callers don't have
 * to branch.
 */

export function isDesktopNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (!isDesktopNotificationSupported()) return "denied";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Fire a desktop notification if (and only if):
 *   1. the API is supported on this device,
 *   2. the user has previously granted permission, and
 *   3. the caller has confirmed the user opted into desktop
 *      notifications in SettingsDialog (we leave that check to the
 *      caller because they usually already have the setting in hand).
 *
 * Silently no-ops on any failure — never throws into the call site.
 */
export function notifyDesktop(title: string, options?: NotificationOptions): void {
  if (!isDesktopNotificationSupported()) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, options);
  } catch {
    /* ignore — some platforms throw when the page is unfocused */
  }
}
