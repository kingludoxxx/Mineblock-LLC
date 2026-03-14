import env from '../config/env.js';
import logger from '../utils/logger.js';

const errorHandler = (err, req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  logger.error({
    message,
    statusCode,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
  });

  const response = {
    success: false,
    error: {
      message,
      ...(env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
  };

  res.status(statusCode).json(response);
};

export default errorHandler;
