import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/errorMiddleware';
import { HttpStatusCodes } from './utils/httpStatus';
import { SECRETS } from './utils/env';

const app = express();

const allowedOrigins = SECRETS.CORS_ORIGIN.split(',').map((origin) => origin.trim());

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Add feature routers here, e.g. app.use('/api/products', productRoutes);

app.get('/', (req: Request, res: Response) => {
  res.status(HttpStatusCodes.OK).json({ status: 'OK', message: 'Server is running' });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(HttpStatusCodes.NOT_FOUND).json({ message: 'Route not found' });
});

app.use(errorHandler);

if (require.main === module) {
  app.listen(SECRETS.PORT, () => {
    console.log(`Server is running on port ${SECRETS.PORT}`);
  });
}

export default app;
