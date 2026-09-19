import { HttpStatusCodes } from './helpers';

export type RegisterUserTypes = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
};

export interface User {
  id: string;
  email: string;
  role: 'customer' | 'admin';
  status: 'active' | 'suspended';
  emailVerifiedAt: Date | null;
  firstName: string;
  lastName: string;
  phone?: string | null;
  avatarUrl?: string | null;
}

export type loginDataType = {
  email: string;
  password: string;
};

export type resetPasswordDataType = {
  password: string;
  confirmPassword: string;
};

export interface validateUserType {
  message: string;
  status: HttpStatusCodes;
}

export interface validateEmailType {
  emailValidationMessage: string;
  emailValidationStatus: HttpStatusCodes;
}
