import { Router, type IRouter } from "express";
import { getHome } from "../services/home";

const router: IRouter = Router();

router.get("/home", async (_req, res, next) => {
  try {
    res.json(await getHome());
  } catch (err) {
    next(err);
  }
});

export default router;
