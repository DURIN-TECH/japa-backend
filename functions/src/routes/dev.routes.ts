import { Router, Request, Response } from "express";
import { eligibilityController } from "../controllers/eligibility.controller";

const router = Router();

router.post("/seed/eligibility", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await eligibilityController.seedNigeriaIreland(req as any, res);
});

router.post("/seed/ireland-visa", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const { seedIrelandVisaData } = await import("../data/seed-ireland-visa");
    const result = await seedIrelandVisaData();
    res.json({
      success: true,
      data: result,
      message: "Ireland visa data seeded",
    });
  } catch (error) {
    console.error("Seed error:", error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

export { router as devRoutes };
