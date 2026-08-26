import type { Env } from "./env.ts";

type TokenResponse = { access_token?: string; error?: string };

export async function exchangeCode(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ code?: string }>();
  if (!body.code) {
    return Response.json({ error: "missing code" }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: body.code,
      }),
    });
  } catch (error) {
    // A dead upstream must read as "Discord unreachable", not as a 500 with a
    // workerd stack trace — this is the one endpoint sign-in depends on.
    console.error("token exchange network failure", error);
    return Response.json({ error: "token exchange unreachable" }, { status: 502 });
  }

  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    console.error(`token exchange rejected: HTTP ${response.status} ${payload.error ?? ""}`);
    return Response.json({ error: "token exchange failed" }, { status: 401 });
  }
  return Response.json({ access_token: payload.access_token });
}
