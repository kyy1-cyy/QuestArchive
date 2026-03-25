import { config } from './config.js';

export function sanitizeImageBasename(title) {
    const base = String(title || '')
        .trim()
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return base || 'image';
}

export async function githubRequest(url, options) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${config.GITHUB.TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(options?.headers || {})
        }
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
}
