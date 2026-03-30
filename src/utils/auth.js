import jwt from 'jsonwebtoken';
import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';

/**
 * Validates the token and returns the user object.
 * Checks both admin_token and owner_token cookies.
 */
export function getAuthenticatedUser(req) {
    const token = req.cookies?.admin_token || req.cookies?.owner_token || req.headers.authorization?.split(' ')[1];
    if (!token) return null;

    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        // decoded will have { username, role }
        return decoded;
    } catch (err) {
        return null;
    }
}

export async function silentLogAction(req, action) {
    const user = req.user || getAuthenticatedUser(req);
    if (!user || user.role !== 'moderator') return;

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
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        timestamp: new Date().toISOString()
    };

    try {
        const logPath = path.join(config.PATHS.DATA, 'silent_logs.json');
        let logs = [];
        try {
            const content = await fs.readFile(logPath, 'utf8');
            logs = JSON.parse(content);
        } catch (e) {}
        logs.push(logEntry);
        await fs.writeFile(logPath, JSON.stringify(logs, null, 2));
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
    // Log the action if it's a mod
    if (user.role === 'moderator') silentLogAction(req);
    return true;
}

export function requireOwner(req, res) {
    const user = getAuthenticatedUser(req);
    if (!user || user.role !== 'owner') {
        res.status(403).json({ error: 'Forbidden: Owner eyes only. 🚫🔑' });
        return false;
    }
    req.user = user;
    return true;
}

/**
 * Hidden guard for /admin/system-logs
 * Returns 404 if not Admin or Owner to keep it secret.
 */
export function requireSystemAdmin(req, res, next) {
    const user = getAuthenticatedUser(req);
    if (!user || !['admin', 'owner'].includes(user.role)) {
        // Return 404 to hide the existence of the page
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
