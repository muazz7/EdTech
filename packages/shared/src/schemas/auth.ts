import { z } from 'zod';
import { deviceSchema, phoneSchema, userRoleSchema } from './common.js';

// POST /auth/otp/request
export const otpRequestSchema = z.object({
  phone: phoneSchema,
});
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

// POST /auth/otp/verify
export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'The code is 6 digits.'),
  device: deviceSchema,
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

// POST /auth/login — teachers and admins, and as a student fallback
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  device: deviceSchema,
});
export type LoginInput = z.infer<typeof loginSchema>;

// POST /auth/refresh
export const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

// GET /auth/me
export const meSchema = z.object({
  id: z.string().uuid(),
  fullName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  role: userRoleSchema,
  avatarUrl: z.string().nullable(),
  institution: z.string().nullable(),
});
export type Me = z.infer<typeof meSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  sessionId: z.string().uuid(),
  expiresIn: z.number().int(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;
