import { requireApiUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { makePreviewWav } from "@/providers/dry-run";
import { getProviders } from "@/providers";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

function previewBody(): ArrayBuffer {
  const bytes = makePreviewWav();
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiUser();
    const { id } = await params;
    if (id === "dry-run") {
      return new Response(previewBody(), {
        headers: {
          "content-type": "audio/wav",
          "cache-control": "private, max-age=300",
        },
      });
    }
    const asset = await db.audioAsset.findUnique({ where: { id } });
    if (!asset?.objectKey || asset.status !== "READY")
      return jsonError("Audio not found", 404);
    if (
      asset.contentType.includes("wav") ||
      process.env.AUDIO_GENERATION_LIVE_ENABLED !== "true"
    ) {
      return new Response(previewBody(), {
        headers: {
          "content-type": "audio/wav",
          "cache-control": "private, max-age=300",
        },
      });
    }
    const url = await getProviders().storage.getReadUrl(asset.objectKey, 900);
    return Response.redirect(url, 302);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError("Audio unavailable", 500);
  }
}
