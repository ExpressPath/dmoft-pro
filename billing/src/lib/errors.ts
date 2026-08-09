export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  console.error("Unhandled request error", error);
  return Response.json(
    { error: { code: "internal_error", message: "The request could not be completed." } },
    { status: 500 },
  );
}
