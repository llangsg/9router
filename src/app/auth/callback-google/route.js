export async function GET(request) {
  const incoming = new URL(request.url);
  const target = new URL("/callback", incoming.origin);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = incoming.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return Response.redirect(target, 302);
}
