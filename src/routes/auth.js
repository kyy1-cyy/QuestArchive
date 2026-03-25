import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts, please try again later' }
});

router.post('/login', loginLimiter, (req, res, next) => {
    try {
        const { password } = req.body;
        
        if (password !== config.ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        const token = jwt.sign({ admin: true }, config.JWT_SECRET, { expiresIn: '7d' });

        res.cookie('admin_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/logout', (req, res, next) => {
    try {
        res.clearCookie('admin_token');
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.get('/check', (req, res, next) => {
    try {
        const token = req.cookies.admin_token;
        if (!token) return res.json({ authenticated: false });

        jwt.verify(token, config.JWT_SECRET);
        res.json({ authenticated: true });
    } catch (err) {
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
            return res.json({ authenticated: false });
        }
        next(err);
    }
});

export default router;
