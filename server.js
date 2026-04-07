import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import expressWinston from 'express-winston';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';
import { config, validateEnv } from './src/utils/config.js';
import { logger } from './src/utils/logger.js';
import { errorHandler } from './src/utils/error-handler.js';
import { ensureCloudflare, requireSystemAdmin } from './src/utils/auth.js';

import authRouter from './src/routes/auth.js';
import gamesRouter from './src/routes/games.js';
import adminRouter from './src/routes/admin.js';
import uploadsRouter from './src/routes/uploads.js';
import donationsRouter from './src/routes/donations.js';
import storageRouter from './src/routes/storage.js';
import githubRouter from './src/routes/github.js';
import logsRouter from './src/routes/logs.js';
import maintenanceRouter from './src/routes/maintenance.js';

const app = express();

validateEnv();

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '100gb' }));
app.use(express.urlencoded({ limit: '100gb', extended: true }));

// Ensure direct stream uploads are NOT handled by body-parser so we can pipe 'req' directly to B2
// The direct route handles its own stream in uploads.js
app.use('/api/uploads/direct', (req, res, next) => next());
app.use('/api/uploads/put-part', (req, res, next) => next());
app.use('/api/donations/put-part', (req, res, next) => next());

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.use(expressWinston.logger({
    winstonInstance: logger,
    meta: true,
    msg: "HTTP {{req.method}} {{req.url}}",
    expressFormat: true,
    colorize: false
}));

// Route the hidden system logs page - returns 404 if not admin/owner
app.get('/admin/system', (req, res) => {
    if (!requireSystemAdmin(req, res)) return;
    res.sendFile(path.join(config.PATHS.PUBLIC, 'system-logs.html'));
});

// Serve static files
app.use(express.static(config.PATHS.PUBLIC, { 
    extensions: ['html'],
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

const cfGuard = (req, res, next) => {
    ensureCloudflare(req, res, next);
};

// API Routes
app.use('/api/admin', authRouter);
app.use('/api', gamesRouter);
app.use('/api', adminRouter);
app.use('/api/uploads', cfGuard, uploadsRouter);
app.use('/api/donations', cfGuard, donationsRouter);
app.use('/api/storage', cfGuard, storageRouter);
app.use('/api/github', githubRouter);
app.use('/api', maintenanceRouter);
app.use('/api', logsRouter);

const swaggerDocument = YAML.load(path.join(config.PATHS.ROOT, 'openapi.yaml'));
if (swaggerDocument) {
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}

app.get('/database', (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.sendFile('database.html', { root: config.PATHS.PUBLIC });
});

// Single Page App Fallback
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.sendFile('index.html', { root: config.PATHS.PUBLIC });
});

app.use(errorHandler);

// Global Crash Guard for ECONNRESET / Aborted Connections
process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.message === 'aborted') {
        logger.warn('Captured aborted connection Exception:', { code: err.code, message: err.message });
        return;
    }
    logger.error('CRITICAL: Uncaught Exception:', err);
    // For critical non-network errors, we should still exit to allow process manager to restart
    if (err.code !== 'ECONNRESET' && err.message !== 'aborted') process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    if (reason && (reason.code === 'ECONNRESET' || reason.message === 'aborted')) {
        logger.warn('Captured aborted connection Rejection:', reason);
        return;
    }
    logger.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

const server = app.listen(config.PORT, async () => {
    logger.info(`🚀 Quest Archive running on http://localhost:${config.PORT}`);
    
    // Increase timeout to 10 hours for very slow/large uploads
    server.timeout = 36000000;
    server.keepAliveTimeout = 36000000;
    server.headersTimeout = 36000000;
    // Configure B2 bucket CORS so browser can upload/download directly
    try {
        const { PutBucketCorsCommand } = await import('@aws-sdk/client-s3');
        const { s3Client: s3 } = await import('./src/utils/s3.js');
        await s3.send(new PutBucketCorsCommand({
            Bucket: config.B2.BUCKET_NAME,
            CORSConfiguration: {
                CORSRules: [{
                    AllowedHeaders: ['*'],
                    AllowedMethods: ['GET', 'PUT', 'HEAD'],
                    AllowedOrigins: ['*'],
                    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
                    MaxAgeSeconds: 86400
                }]
            }
        }));
        logger.info('B2 bucket CORS rules configured');
    } catch (err) {
        logger.warn('B2 CORS setup skipped: ' + (err.message || err));
    }

    // Initialize B2 Bucket Cache
    try {
        const { getBucketFileCache, refreshBucketFileCache } = await import('./src/utils/db.js');
        await getBucketFileCache();
        
        // Safety Refresh every 15 minutes
        setInterval(() => {
            refreshBucketFileCache().catch(err => logger.error('Cache refresh failed', err));
        }, 15 * 60 * 1000);
    } catch (err) {
        logger.error('Failed to initialize B2 cache', err);
    }
});
