import { createHmac, timingSafeEqual } from "node:crypto";
import { config, TOKEN_ISSUER } from "../config.js";
import { AppError } from "../errors.js";

export interface TokenPayload {
  sub: string; // user id
  role: "member" | "admin";
}

interface Claims extends TokenPayload {
  iss: string;
  iat: number;
  exp: number;
}

export type TokenErrorCode = "malformed" | "invalid_signature" | "expired" | "wrong_issuer";

export class TokenError extends AppError {
  constructor(readonly reason: TokenErrorCode) {
    super(`Invalid token: ${reason}`, 401, "unauthorized");
  }
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function sign(data: string): string {
  return createHmac("sha256", config.tokenSecret).update(data).digest("base64url");
}

/** Creates a JWT-style HS256 token. */
export function signToken(payload: TokenPayload, ttlSeconds = config.tokenTtlSeconds, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const claims: Claims = { ...payload, iss: TOKEN_ISSUER, iat, exp: iat + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

/**
 * Validates a token: structure, signature (constant-time), issuer and expiry.
 * A 30-second clock skew is tolerated on expiry.
 */
export function verifyToken(token: string, now = Date.now()): Claims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed");
  const [head, body, sig] = parts;

  const expected = Buffer.from(sign(`${head}.${body}`));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new TokenError("invalid_signature");
  }

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
  } catch {
    throw new TokenError("malformed");
  }
  if (claims.iss !== TOKEN_ISSUER) throw new TokenError("wrong_issuer");
  if (Math.floor(now / 1000) > claims.exp + 30) throw new TokenError("expired");
  return claims;
}

export function issueTokenPair(payload: TokenPayload): { accessToken: string; refreshToken: string } {
  return {
    accessToken: signToken(payload),
    refreshToken: signToken(payload, config.refreshTokenTtlSeconds),
  };
}
