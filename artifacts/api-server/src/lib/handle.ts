import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../services/tasks";

type Handler = (req: Request, res: Response) => Promise<void>;

/** Turns validation and not-found errors into clear 4xx responses. */
export function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues.map((i) => i.message).join("; ") });
      } else if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof ConflictError) {
        res.status(409).json({ error: err.message });
      } else if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
      } else {
        next(err);
      }
    }
  };
}

