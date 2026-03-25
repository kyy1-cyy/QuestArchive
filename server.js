import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import expressWinston from 'express-winston';
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

app.use(express.static(config.PATHS.PUBLIC, { extensions: ['html'] }));

app.use('/api/admin', authRouter);
app.use('/api', gamesRouter);
app.use('/api', adminRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/donations', donationsRouter);
app.use('/api/storage', storageRouter);
app.use('/api/github', githubRouter);
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
