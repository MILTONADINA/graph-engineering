import { Request } from "express";
import multer from "multer";

export interface MulterRequest extends Request {
  files: {
    [fieldname: string]: Express.Multer.File[];
  }
}

// Multer Storage
const storage = multer.memoryStorage();

// Initialize multer with the storage configuration
export const upload = multer({ storage });

