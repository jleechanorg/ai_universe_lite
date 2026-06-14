import express, { type Request, type Response, type NextFunction } from "express";
import { logger } from "./lib/logger.js";
import { HttpError, errorHandler } from "./lib/errors.js";
import { loadConfig } from "./config.js";
import { gemsRouter } from "./routes/gems.js";
import { refsRouter } from "./routes/refs.js";
import { registryRouter } from "./routes/registry.js";
import { deleteRefs } from "./stores/storage.js";

const config = loadConfig();
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.debug({ method: req.method, url: req.url }, "request");
  next();
});

// Health
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "ai-universe-lite-backend", env: config.nodeEnv });
});

// Routes
app.use("/api/gems", gemsRouter);
app.use("/api/refs", refsRouter);
app.use("/api/registry", registryRouter);

// Cron endpoints (called by Cloud Scheduler via OIDC; auth check left to ingress).
app.post("/api/cron/ref-gc", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const intakeId = String(req.body?.intakeId ?? req.query?.intakeId ?? "");
    if (!intakeId) {
      throw new HttpError(400, "missing_intakeId", "intakeId is required");
    }
    await deleteRefs(intakeId);
    logger.info({ intakeId }, "cron ref-gc deleted refs");
    res.json({ ok: true, intakeId });
  } catch (err) {
    next(err);
  }
});

app.post(
  "/api/cron/preview-cleanup",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // For Phase 1, the preview-cleanup hook is a no-op stub.
      // Phase 2 will call into a `deleteGemPreview(gemId)` helper to remove
      // PR preview Cloud Run services and GCR tags older than 6h.
      const gemId = String(req.body?.gemId ?? req.query?.gemId ?? "");
      logger.info({ gemId }, "cron preview-cleanup: no-op stub");
      res.json({ ok: true, gemId, noop: true });
    } catch (err) {
      next(err);
    }
  },
);

// 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { code: "not_found", message: "route not found" } });
});

// Error handler (last)
app.use(errorHandler);

if (config.nodeEnv !== "test") {
  const port = config.port;
  app.listen(port, () => {
    logger.info({ port, env: config.nodeEnv }, "AI Universe Lite backend listening");
  });
}

export { app };
