import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { config } from '../config/env';
import { AuthPayload } from '../types';

export const generateToken = (payload: AuthPayload): string =>
  jwt.sign(payload, config.JWT_SECRET as Secret, {
    expiresIn: config.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  });

export const generateRefreshToken = (payload: AuthPayload): string =>
  jwt.sign(payload, config.JWT_REFRESH_SECRET as Secret, {
    expiresIn: config.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
  });

export const verifyToken = (token: string): AuthPayload =>
  jwt.verify(token, config.JWT_SECRET) as AuthPayload;

export const verifyRefreshToken = (token: string): AuthPayload =>
  jwt.verify(token, config.JWT_REFRESH_SECRET) as AuthPayload;
