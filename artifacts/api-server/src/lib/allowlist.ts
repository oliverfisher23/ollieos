/**
 * OllieOS has one user. Only the email in the ALLOWED_EMAIL secret may sign in.
 * Fails closed: if the secret is missing, nobody is allowed.
 */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  if (!allowed || !email) return false;
  return email.trim().toLowerCase() === allowed;
}
