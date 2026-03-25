import { logger } from './logger.js';

export function errorHandler(err, req, res, next) {
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';

    logger.error(`${status} - ${message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

    if (process.env.NODE_ENV === 'development') {
        res.status(status).json({
            error: message,
            stack: err.stack
        });
    } else {
        res.status(status).json({
            error: message
        });
    }
}

export class AppError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
        Error.captureStackTrace(this, this.constructor);
    }
}
