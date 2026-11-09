import type { NextFunction, Request, Response } from "express";
import { isAllowedEmail } from "../lib/allowlist";

/**
 * Every app route sits behind this. Signed out gets 401, signed in with any
 * other email gets 403 "Not authorised", and neither gets any data.
 */
export function requireOllie(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  if (!isAllowedEmail(req.user.email)) {
    res.status(403).json({ error: "Not authorised" });
    return;
  }
  next();
}
