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

import authRouter from './src/routes/auth.js';
import gamesRouter from './src/routes/games.js';
import adminRouter from './src/routes/admin.js';
import uploadsRouter from './src/routes/uploads.js';
import donationsRouter from './src/routes/donations.js';
import storageRouter from './src/routes/storage.js';
import githubRouter from './src/routes/github.js';
import maintenanceRouter from './src/routes/maintenance.js';
import logsRouter from './src/routes/logs.js';

const app = express();

validateEnv();

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));

app.use(expressWinston.logger({
    winstonInstance: logger,
    meta: true,
    msg: "HTTP {{req.method}} {{req.url}}",
    expressFormat: true,
    colorize: false
}));

app.use(express.static(config.PATHS.PUBLIC, { 
    extensions: ['html'],
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

app.use('/api/admin', authRouter);
app.use('/api', gamesRouter);
app.use('/api', adminRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/donations', donationsRouter);
app.use('/api/storage', storageRouter);
app.use('/api/github', githubRouter);
app.use('/api', maintenanceRouter);
app.use('/api', logsRouter);

const swaggerDocument = YAML.load(path.join(config.PATHS.ROOT, 'openapi.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get('/database', (req, res) => {
    res.sendFile('database.html', { root: config.PATHS.PUBLIC });
});

app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile('index.html', { root: config.PATHS.PUBLIC });
});

app.use(errorHandler);

app.listen(config.PORT, () => {
    logger.info(`🚀 Quest Archive running on http://localhost:${config.PORT}`);
});
