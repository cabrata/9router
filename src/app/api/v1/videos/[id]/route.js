import { withRequestLog } from "@/lib/requestLog.js";
import { handleVideoGet } from "@/sse/handlers/videoGeneration.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** GET /v1/videos/{request_id} - poll async video job status (xAI Grok Imagine) */
async function _GET(request, { params }) {
  const { id } = await params;
  return await handleVideoGet(request, id);
}

export const GET = withRequestLog("video", _GET);
