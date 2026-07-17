import jwt from 'jsonwebtoken';
import env from '../config/env.js';

export const signAccessToken = (payload, expiresIn = '15m') => {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn });
};

export const signRefreshToken = (payload) => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
};

export const verifyAccessToken = (token) => {
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
};

export const verifyRefreshToken = (token) => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
};
