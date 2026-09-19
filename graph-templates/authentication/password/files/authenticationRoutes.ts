import express from 'express';
import { z } from 'zod';
import { AuthenticationController } from '../controllers/authenticationController';
import { asyncHandler } from '../middlewares/asyncHandler';
import { authMiddleware } from '../middlewares/authMiddleware';
import { validateBody } from '../middlewares/validationMiddleware';

const router = express.Router();
const controller = new AuthenticationController();

const registerSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min({{input.minPasswordLength}}),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/register', validateBody(registerSchema), asyncHandler(controller.register));
router.post('/login', validateBody(loginSchema), asyncHandler(controller.login));
router.get('/me', authMiddleware, asyncHandler(controller.me));
router.post('/forgot-password', asyncHandler(controller.forgotPassword));
router.post('/reset-password/:resetToken', asyncHandler(controller.resetPassword));
router.post('/verify-email/:verifyToken', asyncHandler(controller.verifyEmail));
router.post('/logout', authMiddleware, asyncHandler(controller.logout));

export const authenticationRoutes = router;
