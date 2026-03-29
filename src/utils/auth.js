import jwt from 'jsonwebtoken';
import { config } from './config.js';

export function requireAdmin(req, res) {
    const token = req.cookies?.admin_token || req.headers.authorization?.split(' ')[1];
    const headerPassword = req.headers['password'];

    if (headerPassword && headerPassword === config.ADMIN_PASSWORD) {
        return true;
    }

    if (!token) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }

    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        return true;
    } catch (err) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
}

export function requireOwner(req, res) {
    // 1. Check for the Super Admin (Owner) Token cookie
    const token = req.cookies?.owner_token;
    // 2. Check for the Owner password in headers (for dev tools/overrides)
    const headerPassword = req.headers['owner-password'];

    // If you provide the physical owner password, you get in instantly
    if (headerPassword && headerPassword === config.OWNER_PASSWORD) {
        return true;
    }

    // If you have the Owner JWT cookie, you get in
    if (token) {
        try {
            const decoded = jwt.verify(token, config.JWT_SECRET);
            if (decoded.role === 'owner') return true;
        } catch (err) {
            // Token expired or invalid
        }
    }

    // If neither, we reject even if they are a "Mod"
    res.status(403).json({ error: 'Forbidden: Owner eyes only. 🚫🔑' });
    return false;
}

export function ensureCloudflare(req, res, next) {
    if (!config.CLOUDFLARE_ON) {
        res.status(503).json({ error: 'Cloudflare services are currently disabled by the administrator. 🛑' });
        return false;
    }
    if (next) return next();
    return true;
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
