import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

// Import routes
import { authRoutes } from './routes/authRoutes';

// Import middlewares
import { errorHandler } from './middlewares/errorMiddleware';

// helper functions
import { HttpStatusCodes, SECRETS } from './utils/helpers';

// Create Express app
const app = express();

// Middleware
const allowedOrigins = SECRETS.CORS_ORIGIN.split(',').map((origin) => origin.trim());

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(helmet()); // Set security HTTP headers
app.use(morgan('dev')); // HTTP request logger
app.use(express.json()); // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request bodies
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);


// Health check route
app.get('/', async (req: Request, res: Response) => {
  try {
    res.status(HttpStatusCodes.OK).json({
      status: 'OK',
      message: 'Server is running',
    });
  } catch (error) {
    res.status(HttpStatusCodes.INTERNAL_SERVER_ERROR).json({
      status: 'ERROR',
      message: 'There was an error while processing your request',
    });
  }
});

// 404 Route
app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(HttpStatusCodes.NOT_FOUND).json({ message: 'Route not found' });
});

// Error handling middleware
app.use(errorHandler);

const PORT = SECRETS.PORT;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;
