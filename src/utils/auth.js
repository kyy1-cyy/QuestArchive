import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { readJsonFromR2, writeJsonToR2 } from './s3-helpers.js';

/**
 * Validates the token and returns the user object.
 * Checks both admin_token and owner_token cookies.
 */
export function getAuthenticatedUser(req) {
    const token = req.cookies?.admin_token || req.cookies?.owner_token || req.headers.authorization?.split(' ')[1];
    if (!token) return null;

    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        return decoded;
    } catch (err) {
        return null;
    }
}

export async function silentLogAction(req, action) {
    const user = req.user || getAuthenticatedUser(req);
    // Log any known staff member (including JJ, Tear, Misterio)
    if (!user || !['owner', 'admin', 'moderator'].includes(user.role)) return;

    // Intelligent action descriptions
    let finalAction = action;
    if (!finalAction) {
        const path = req.originalUrl;
        const method = req.method;

        if (path === '/api/database' && method === 'POST') finalAction = 'Add Game';
        else if (path === '/api/database/bulk-delete' && method === 'POST') finalAction = 'Bulk Remove Games';
        else if (path === '/api/storage/delete') finalAction = 'Delete Storage File';
        else if (path === '/api/storage/bulk-delete') finalAction = 'Bulk Delete Storage';
        else if (path === '/api/uploads/init') finalAction = 'Init Upload';
        else if (path === '/api/uploads/complete') finalAction = 'Finalize Upload';
        else if (method === 'POST') finalAction = 'Submit Change';
        else if (method === 'DELETE') finalAction = 'Remove Item';
        else finalAction = `${method} ${path}`;
    }

    const logEntry = {
        username: user.username,
        role: user.role,
        action: finalAction,
        timestamp: new Date().toISOString(),
        detail: {
            method: req.method || '',
            path: req.originalUrl || '',
            body: req.body && Object.keys(req.body).length ? req.body : undefined,
            userAgent: req.headers?.['user-agent'] || '',
            referrer: req.headers?.referer || ''
        }
    };

    try {
        // Persistent logs on Cloudflare R2 - 24/7 access
        const logs = await readJsonFromR2(config.R2.SILENT_LOGS_KEY, []);
        logs.push(logEntry);
        await writeJsonToR2(config.R2.SILENT_LOGS_KEY, logs);
    } catch (e) {
        // Fail silently as per requirement
    }
}

export function requireAdmin(req, res) {
    const user = getAuthenticatedUser(req);
    if (!user || !['moderator', 'admin', 'owner'].includes(user.role)) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    req.user = user;
    silentLogAction(req);
    return true;
}

/**
 * JJ, Tear, Misterio (Full Access)
 */
export function requireOwner(req, res) {
    const user = getAuthenticatedUser(req);
    if (!user || !['admin', 'owner'].includes(user.role)) {
        res.status(403).json({ error: 'Forbidden: Admin or Owner eyes only. 🚫🔑' });
        return false;
    }
    req.user = user;
    silentLogAction(req); // Log even Admin Actions (Tear, Misterio)
    return true;
}

/**
 * Hidden guard for /admin/system-logs
 */
export function requireSystemAdmin(req, res, next) {
    const user = getAuthenticatedUser(req);
    if (!user || !['admin', 'owner'].includes(user.role)) {
        return res.status(404).send('Not Found');
    }
    req.user = user;
    if (next) return next();
    return true;
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
