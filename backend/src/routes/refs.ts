import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { newIntakeId } from "../lib/crypto.js";
import { getGemIntake, createGemIntake } from "../stores/firestore.js";
import {
  uploadRef,
  getSignedDownloadUrl,
  listRefs,
} from "../stores/storage.js";

const router = Router();

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_INTAKE_BYTES = 200 * 1024 * 1024; // 200 MB
const MIME_WHITELIST = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (MIME_WHITELIST.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new HttpError(400, "mime_not_allowed", `mime ${file.mimetype} is not in the whitelist`));
    }
  },
});

const SignQuerySchema = z.object({
  intakeId: z.string().min(1),
  filename: z.string().min(1),
  ttlSeconds: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(3600),
});

/**
 * POST /api/refs — Multipart upload of one or more reference files.
 * If `intakeId` is not provided in the form data, a new intake is created.
 */
router.post(
  "/",
  upload.array("files"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        throw new HttpError(400, "no_files", "at least one file is required");
      }
      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
      if (totalBytes > MAX_INTAKE_BYTES) {
        throw new HttpError(
          413,
          "intake_too_large",
          `intake exceeds 200 MB limit (${totalBytes} bytes)`,
        );
      }
      const formIntakeId = String(req.body.intakeId ?? "").trim();
      const intakeId = formIntakeId || newIntakeId();
      if (formIntakeId) {
        const existing = await getGemIntake(formIntakeId);
        if (!existing) {
          throw new HttpError(404, "intake_not_found", `intake ${formIntakeId} not found`);
        }
      } else {
        await createGemIntake({
          prompt: String(req.body.prompt ?? ""),
          authorUid: String(req.body.authorUid ?? "anonymous"),
          visibility: "unlisted",
          refPaths: [],
        });
      }

      const uploaded = [];
      for (const file of files) {
        const result = await uploadRef(
          intakeId,
          file.originalname,
          file.mimetype,
          file.buffer,
        );
        uploaded.push(result);
      }
      res.status(201).json({ intakeId, refs: uploaded });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/refs/sign?intakeId=<id>&filename=<name>&ttlSeconds=<n> —
 * Returns a v4 signed URL for ephemeral download.
 */
router.get("/sign", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = SignQuerySchema.parse(req.query);
    const url = await getSignedDownloadUrl(q.intakeId, q.filename, q.ttlSeconds);
    res.json({ intakeId: q.intakeId, filename: q.filename, signedUrl: url });
  } catch (err) {
    next(err);
  }
});

/** GET /api/refs/list?intakeId=<id> — list refs in an intake. */
router.get("/list", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const intakeId = String(req.query.intakeId ?? "");
    if (!intakeId) throw new HttpError(400, "missing_intakeId", "intakeId is required");
    const items = await listRefs(intakeId);
    res.json({ intakeId, refs: items });
  } catch (err) {
    next(err);
  }
});

export { router as refsRouter };
