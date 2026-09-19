import express, { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { database } from '../config/database';
import { refreshTokenTable } from '../config/schema';
import { asyncHandler } from '../middlewares/asyncHandler';
import { APIError } from '../middlewares/errorMiddleware';
import { HttpStatusCodes } from '../utils/helpers';
import { generateAccessToken, generateRefreshToken, hashToken } from '../utils/tokens';

const router = express.Router();

router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.refresh_token;
  if (!token) {
    throw new APIError('Refresh token required', HttpStatusCodes.UNAUTHORIZED);
  }

  const tokenHash = hashToken(token);
  const [stored] = await database
    .select()
    .from(refreshTokenTable)
    .where(eq(refreshTokenTable.tokenHash, tokenHash))
    .limit(1);

  if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) {
    throw new APIError('Invalid or expired refresh token', HttpStatusCodes.UNAUTHORIZED);
  }

  // Rotate: revoke the used refresh token and issue a new one.
  await database
    .update(refreshTokenTable)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokenTable.id, stored.id));

  const rotated = generateRefreshToken();
  await database.insert(refreshTokenTable).values({
    userId: stored.userId,
    tokenHash: rotated.tokenHash,
    expiresAt: rotated.expiresAt,
  });

  const accessToken = generateAccessToken(stored.userId, 'customer');

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refresh_token', rotated.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: rotated.expiresAt.getTime() - Date.now(),
  });

  return res.status(HttpStatusCodes.OK).json({ message: 'Token refreshed' });
}));

export const authRefreshRoutes = router;
