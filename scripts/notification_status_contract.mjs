export const NOTIFICATION_STATUS_ALLOWED_OPERATIONS = Object.freeze(["notifications.status.read"]);
export const NOTIFICATION_STATUS_FORBIDDEN_OPERATIONS = Object.freeze([
  "notifications.deliver",
  "applications.submit",
  "applications.update",
  "recruiters.contact",
  "email.send",
  "gmail.send",
]);

export function requireNotificationStatusOperation(operation) {
  if (!NOTIFICATION_STATUS_ALLOWED_OPERATIONS.includes(operation)) {
    throw new Error("Notification status connector permits only notifications.status.read");
  }
  return operation;
}
