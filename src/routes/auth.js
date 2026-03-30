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
        
        // Find user by password hash
        const userData = config.USERS[password];

        if (!userData) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        const token = jwt.sign(
            { username: userData.username, role: userData.role }, 
            config.JWT_SECRET, 
            { expiresIn: '7d' }
        );

        // We'll use one cookie for all staff roles to simplify the frontend
        res.cookie('admin_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production' || req.hostname !== 'localhost',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        // For owner, also set owner_token to maintain compatibility with existing UI guards
        if (userData.role === 'owner') {
            res.cookie('owner_token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production' || req.hostname !== 'localhost',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000
            });
        }

        // Silent Log if it's a mod
        if (userData.role === 'moderator') {
            import('../utils/auth.js').then(({ silentLogAction }) => {
                req.user = { username: userData.username, role: userData.role };
                silentLogAction(req, 'Logged In');
            }).catch(() => {});
        }

        res.json({ success: true, role: userData.role, username: userData.username });
    } catch (err) {
        next(err);
    }
});

/**
 * Legacy owner login for direct manual testing
 */
router.post('/owner/login', loginLimiter, (req, res, next) => {
    // Keep it for now but point to the same logic
    req.url = '/login';
    return router.handle(req, res, next);
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

import { getAuthenticatedUser } from '../utils/auth.js';

router.get('/check', (req, res, next) => {
    try {
        const user = getAuthenticatedUser(req);
        
        if (!user) {
            return res.json({ authenticated: false, isOwner: false, role: null });
        }

        res.json({ 
            authenticated: true, 
            isOwner: user.role === 'owner',
            isAdmin: ['admin', 'owner'].includes(user.role),
            role: user.role,
            username: user.username
        });
    } catch (err) {
        next(err);
    }
});
/**
 * Frontend reporting for UI Events (Open Tab, Click Button)
 * Logged silently for Moderators.
 */
router.post('/log-ui-event', (req, res) => {
    try {
        const user = getAuthenticatedUser(req);
        if (user && ['owner','admin','moderator'].includes(user.role)) {
            const { event, detail } = req.body;
            req.user = user;
            silentLogAction(req, `${event}${detail ? ': ' + detail : ''}`);
        }
        res.status(204).end(); // Silent response
    } catch (err) {
        res.status(204).end();
    }
});

export default router;
