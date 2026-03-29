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
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/owner/login', loginLimiter, (req, res, next) => {
    try {
        const { password } = req.body;
        if (!config.OWNER_PASSWORD || password !== config.OWNER_PASSWORD) {
            return res.status(401).json({ error: 'Invalid owner password' });
        }
        const token = jwt.sign({ role: 'owner' }, config.JWT_SECRET, { expiresIn: '7d' });
        res.cookie('owner_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.post('/logout', (req, res, next) => {
    try {
        res.clearCookie('admin_token');
        res.clearCookie('owner_token');
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.get('/check', (req, res, next) => {
    try {
        const token = req.cookies.admin_token;
        const ownerToken = req.cookies.owner_token;
        
        const status = { authenticated: false, isOwner: false };

        if (!token && !ownerToken) return res.json(status);

        if (token) {
            try {
                jwt.verify(token, config.JWT_SECRET);
                status.authenticated = true;
            } catch (err) { }
        }

        if (ownerToken) {
            try {
                const decoded = jwt.verify(ownerToken, config.JWT_SECRET);
                if (decoded.role === 'owner') {
                    status.isOwner = true;
                }
            } catch (err) { }
        }

        res.json(status);
    } catch (err) {
        next(err);
    }
});

export default router;
