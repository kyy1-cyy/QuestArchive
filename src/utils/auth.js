import jwt from 'jsonwebtoken';
import { config } from './config.js';

export function requireAdmin(req, res) {
    const token = req.cookies?.admin_token || req.headers.authorization?.split(' ')[1];
    const headerPassword = req.headers['password'];
    
    // Fallback for user's original frontend code (if it still uses headers)
    if (headerPassword && headerPassword === config.ADMIN_PASSWORD) {
        return true;
    }

    if (!token) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }

    try {
        jwt.verify(token, config.JWT_SECRET);
        return true;
    } catch (err) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
}

export function ensureEnv(req, res, keys) {
    const missing = [];
    keys.forEach(k => {
        const val = k.split('.').reduce((o, i) => o?.[i], config);
        if (!val) missing.push(k);
    });

    if (missing.length) {
        res.status(500).json({
            error: `Server missing required configurations: ${missing.join(', ')}`
        });
        return false;
    }
    return true;
}
