export interface WsJwtPayload {
  userId: number;
  role: string;
  email?: string;
  restaurantId?: number;
  restaurantRole?: string;
  branchIds?: number[];
}

export interface HandshakeShape {
  auth?: { token?: string };
  headers: Record<string, unknown>;
}

/**
 * Token sources for the websocket handshake, in order:
 *   1. `auth.token`           — native/mobile clients via io(url, {auth:{token}}).
 *   2. `access_token` cookie  — browser sessions reuse the HTTP login cookie.
 * Query-string tokens are intentionally NOT supported (they leak into logs).
 *
 * Verification is delegated to the caller (gateway injects
 * `AuthUtilsService.verifyAccessToken`) so this helper stays framework-agnostic.
 */
export function authenticateHandshake(
  handshake: HandshakeShape,
  verify: (token: string) => WsJwtPayload,
): WsJwtPayload {
  const cookieToken = extractCookie(
    handshake.headers.cookie as string | undefined,
    'access_token',
  );
  const token = handshake.auth?.token ?? cookieToken;
  if (!token) throw new Error('ws: no token');

  try {
    return verify(token);
  } catch {
    throw new Error('ws: invalid token');
  }
}

/** Channels (socket.io rooms) the user is allowed to join. */
export function permittedChannels(user: WsJwtPayload): Set<string> {
  const allowed = new Set<string>();
  if (user.role === 'customer') {
    allowed.add(`customer:${user.userId}`);
  }
  if (user.role === 'restaurant_user' && user.restaurantId) {
    allowed.add(`restaurant:${user.restaurantId}`);
    for (const b of user.branchIds ?? []) allowed.add(`branch:${b}`);
  }
  if (user.role === 'delivery_agent') {
    allowed.add(`agent:${user.userId}`);
  }
  return allowed;
}

function extractCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
