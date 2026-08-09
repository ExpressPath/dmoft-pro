export async function GET(): Promise<Response> {
  return Response.json(
    { status: "ok", service: "dmoft-pro-billing", version: "0.1.0" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
