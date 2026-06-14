import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { getGemByShareToken, listGems } from "../stores/firestore.js";

const router = Router();

const ListQuerySchema = z.object({
  visibility: z.enum(["private", "unlisted", "public"]).optional(),
  authorUid: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

/** Public shape — no secrets, no internal runIds. */
function toPublic(g: {
  gemId: string;
  name: string;
  version: string;
  description?: string;
  authorUid: string;
  visibility: "private" | "unlisted" | "public";
  cloudRunUrl: string | null;
  deployedEnv?: string | null;
  createdAtIso: string;
}) {
  return {
    gemId: g.gemId,
    name: g.name,
    version: g.version,
    description: g.description ?? "",
    authorUid: g.authorUid,
    visibility: g.visibility,
    cloudRunUrl: g.cloudRunUrl,
    deployedEnv: g.deployedEnv ?? null,
    createdAtIso: g.createdAtIso,
  };
}

/**
 * GET /api/registry/:shareToken — Public read of a gem by its share token.
 * Returns 410 Gone for soft-deleted gems (per AGENTS.md).
 */
router.get("/:shareToken", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = String(req.params.shareToken);
    if (!token) throw new HttpError(400, "missing_shareToken", "shareToken is required");
    const gem = await getGemByShareToken(token);
    if (!gem) throw new HttpError(404, "gem_not_found", "no gem with that share token");
    if (gem.status === "deleted") {
      throw new HttpError(410, "gem_deleted", "this gem has been removed");
    }
    res.json(toPublic(gem));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/registry — Paginated list of public + unlisted gems.
 * Private gems are never listed unless the caller is the author (auth check
 * is the caller's responsibility; the route only filters by `authorUid`).
 */
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = ListQuerySchema.parse(req.query);
    const { gems, nextCursor } = await listGems({
      visibility: q.visibility,
      authorUid: q.authorUid,
      limit: q.limit,
      cursor: q.cursor,
    });
    res.json({
      gems: gems.map(toPublic),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

export { router as registryRouter };
