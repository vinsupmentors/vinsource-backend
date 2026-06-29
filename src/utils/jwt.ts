import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { AuthPayload } from '../types';

export const generateToken = (payload: AuthPayload): string =>
  jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });

export const generateRefreshToken = (payload: AuthPayload): string =>
  jwt.sign(payload, config.JWT_REFRESH_SECRET, { expiresIn: config.JWT_REFRESH_EXPIRES_IN });

export const verifyToken = (token: string): AuthPayload =>
  jwt.verify(token, config.JWT_SECRET) as AuthPayload;

export const verifyRefreshToken = (token: string): AuthPayload =>
  jwt.verify(token, config.JWT_REFRESH_SECRET) as AuthPayload;
