import { Request } from 'express';
import multer from 'multer';

export interface MulterRequest extends Request {
  files: {
    [fieldname: string]: Express.Multer.File[];
  };
}

const storage = multer.memoryStorage();

export const upload = multer({ storage });
