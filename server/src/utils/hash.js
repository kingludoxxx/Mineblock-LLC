import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

export const hashPassword = async (plaintext) => {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  return bcrypt.hash(plaintext, salt);
};

export const comparePassword = async (plaintext, hashed) => {
  return bcrypt.compare(plaintext, hashed);
};
