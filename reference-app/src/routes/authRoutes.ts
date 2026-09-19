import express, { Request, Response } from 'express';
import { AuthenticationService } from '../services/authService';
import { authMiddleware } from '../middlewares/authMiddleware';
const router = express.Router();

const authService = new AuthenticationService();

router.post('/register', (req: Request, res: Response) => authService.register(req, res));

router.post('/login', (req: Request, res: Response) => authService.login(req, res));

router.post('/forgot-password', (req: Request, res: Response) => authService.forgotPassword(req, res));

router.post('/reset-password/:resetToken', (req: Request, res: Response) => authService.resetPassword(req, res));

router.post('/verify-email/:verifyToken', (req: Request, res: Response) => authService.verifyEmail(req, res));

router.post('/logout', authMiddleware, (req: Request, res: Response) => authService.logout(req, res));

export const authRoutes = router;
