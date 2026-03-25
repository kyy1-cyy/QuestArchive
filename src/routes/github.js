import express from 'express';
import { config } from '../utils/config.js';
import { sanitizeImageBasename, githubRequest } from '../utils/github-helpers.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.post('/images', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureEnv(req, res, ['GITHUB.TOKEN', 'GITHUB.OWNER', 'GITHUB.REPO'])) return;

    const { title, contentType, base64 } = req.body ?? {};
    if (!title || !contentType || !base64) return res.status(400).json({ error: 'Missing data' });

    const ext = contentType.includes('png') ? 'png' : 'jpeg';
    const name = `${sanitizeImageBasename(title)}.${ext}`;
    const filePath = `${config.GITHUB.IMAGES_PATH.replace(/\/+$/, '')}/${name}`;

    try {
        const url = `https://api.github.com/repos/${config.GITHUB.OWNER}/${config.GITHUB.REPO}/contents/${filePath}`;

        const check = await githubRequest(url);
        let sha = null;
        if (check.ok && check.json?.sha) sha = check.json.sha;

        const put = await githubRequest(url, {
            method: 'PUT',
            body: JSON.stringify({
                message: `Upload image: ${name}`,
                content: base64,
                branch: config.GITHUB.BRANCH,
                sha
            })
        });

        if (!put.ok) throw new Error(put.json?.message || 'GitHub upload failed');

        const rawUrl = `https://raw.githubusercontent.com/${config.GITHUB.OWNER}/${config.GITHUB.REPO}/${config.GITHUB.BRANCH}/${filePath}`;
        res.json({ success: true, url: rawUrl, name });
    } catch (err) {
        next(err);
    }
});

export default router;
