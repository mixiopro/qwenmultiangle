const express = require('express');
const multer = require('multer');
const path = require('path');
const { fal } = require('@fal-ai/client');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

const FAL_MODEL_ID = 'fal-ai/qwen-image-edit-2511-multiple-angles';
const NEXT_SCENE_MODEL_ID = 'fal-ai/qwen-image-edit-plus-lora-gallery/next-scene';
const VIDEO_MODEL_BY_KEY = {
    seedance: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
    kling26: 'fal-ai/kling-video/v2.6/standard/image-to-video',
    veo31: 'fal-ai/veo3.1/fast/first-last-frame-to-video'
};

if (!process.env.FAL_API_KEY) {
    console.warn('FAL_API_KEY is not set. Fal endpoints will fail until it is provided.');
}

fal.config({
    credentials: process.env.FAL_API_KEY || ''
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

function sendApiError(res, error, fallbackStatus = 500) {
    const status = error?.status || error?.response?.status || fallbackStatus;
    const body = error?.body || error?.response?.data;
    const message = body?.detail || body?.message || error?.message || 'Unexpected server error';
    res.status(status).json({ error: message, detail: body || null });
}

function normalizeImageResult(result) {
    const data = result?.data || result;
    return data?.images?.[0]?.url || data?.image?.url || null;
}

function normalizeVideoResult(result) {
    const data = result?.data || result;
    return data?.video?.url || data?.videos?.[0]?.url || null;
}

function normalizeNextScenePrompt(prompt) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!trimmedPrompt) {
        return null;
    }

    const promptBody = trimmedPrompt.replace(/^next\s*scene\s*:\s*/i, '').trim();
    if (!promptBody) {
        return null;
    }

    return `Next Scene: ${promptBody}`;
}

function normalizeNextSceneLoraScale(value) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
        return 0.75;
    }

    return Math.min(0.8, Math.max(0.7, parsedValue));
}

app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided.' });
        }

        const uploadedUrl = await fal.storage.upload(new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }));
        return res.json({ url: uploadedUrl });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.post('/api/generate-image', async (req, res) => {
    try {
        const { imageUrl, horizontal_angle, vertical_angle, zoom } = req.body || {};

        if (!imageUrl) {
            return res.status(400).json({ error: 'imageUrl is required.' });
        }

        const result = await fal.run(FAL_MODEL_ID, {
            input: {
                image_urls: [imageUrl],
                horizontal_angle,
                vertical_angle,
                zoom
            }
        });

        const outputUrl = normalizeImageResult(result);
        if (!outputUrl) {
            return res.status(502).json({ error: 'No image URL was returned by the provider.' });
        }

        return res.json({ imageUrl: outputUrl });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.post('/api/generate-next-scene', async (req, res) => {
    try {
        const { imageUrl, prompt, loraScale } = req.body || {};

        if (!imageUrl) {
            return res.status(400).json({ error: 'imageUrl is required.' });
        }

        const normalizedPrompt = normalizeNextScenePrompt(prompt);
        if (!normalizedPrompt) {
            return res.status(400).json({ error: 'prompt is required and must describe the next scene.' });
        }

        const queueRequest = await fal.queue.submit(NEXT_SCENE_MODEL_ID, {
            input: {
                image_urls: [imageUrl],
                prompt: normalizedPrompt,
                lora_scale: normalizeNextSceneLoraScale(loraScale)
            }
        });

        const requestId = queueRequest?.request_id || queueRequest?.requestId;
        if (!requestId) {
            return res.status(502).json({ error: 'No request ID was returned by the provider.' });
        }

        return res.status(202).json({
            requestId,
            status: 'queued',
            pollUrl: `/api/generate-next-scene/${requestId}`
        });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.get('/api/generate-next-scene/:requestId', async (req, res) => {
    try {
        const requestId = req.params?.requestId;
        if (!requestId) {
            return res.status(400).json({ error: 'requestId is required.' });
        }

        const queueStatus = await fal.queue.status(NEXT_SCENE_MODEL_ID, {
            requestId,
            logs: false
        });

        if (queueStatus?.status === 'IN_QUEUE') {
            return res.json({ status: 'queued' });
        }

        if (queueStatus?.status === 'IN_PROGRESS') {
            return res.json({ status: 'in_progress' });
        }

        if (queueStatus?.status === 'COMPLETED') {
            try {
                const result = await fal.queue.result(NEXT_SCENE_MODEL_ID, { requestId });
                const outputUrl = normalizeImageResult(result);
                if (!outputUrl) {
                    return res.json({
                        status: 'failed',
                        error: 'No image URL was returned by the provider.',
                        detail: result?.data || result || null
                    });
                }

                return res.json({ status: 'completed', imageUrl: outputUrl });
            } catch (error) {
                const statusCode = error?.status || error?.response?.status || 500;
                const body = error?.body || error?.response?.data || null;
                const message = body?.detail || body?.message || error?.message || 'Next scene generation failed.';

                if ([408, 429, 500, 502, 503, 504].includes(statusCode)) {
                    return sendApiError(res, error);
                }

                return res.json({
                    status: 'failed',
                    error: message,
                    detail: body
                });
            }
        }

        const fallbackMessage = queueStatus?.detail || queueStatus?.message || `Unexpected queue status: ${queueStatus?.status || 'unknown'}`;
        return res.json({
            status: 'failed',
            error: typeof fallbackMessage === 'string' ? fallbackMessage : 'Next scene generation failed.',
            detail: queueStatus || null
        });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.post('/api/video/segment', async (req, res) => {
    try {
        const {
            modelKey,
            prompt,
            image_url,
            end_image_url,
            duration,
            resolution,
            camera_fixed,
            generate_audio
        } = req.body || {};

        const modelId = VIDEO_MODEL_BY_KEY[modelKey];
        if (!modelId || modelKey === 'veo31') {
            return res.status(400).json({ error: 'Invalid modelKey for segment generation.' });
        }

        if (!image_url || !end_image_url) {
            return res.status(400).json({ error: 'image_url and end_image_url are required.' });
        }

        const result = await fal.subscribe(modelId, {
            input: {
                prompt,
                image_url,
                end_image_url,
                duration,
                resolution,
                camera_fixed,
                generate_audio
            },
            logs: false
        });

        const videoUrl = normalizeVideoResult(result);
        if (!videoUrl) {
            return res.status(502).json({ error: 'No video URL was returned by the provider.' });
        }

        return res.json({ videoUrl });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.post('/api/video/first-last', async (req, res) => {
    try {
        const { modelKey, prompt, first_frame_url, last_frame_url } = req.body || {};

        const modelId = VIDEO_MODEL_BY_KEY[modelKey];
        if (!modelId || modelKey !== 'veo31') {
            return res.status(400).json({ error: 'Invalid modelKey for first-last generation.' });
        }

        if (!first_frame_url || !last_frame_url) {
            return res.status(400).json({ error: 'first_frame_url and last_frame_url are required.' });
        }

        const result = await fal.subscribe(modelId, {
            input: { prompt, first_frame_url, last_frame_url },
            logs: false
        });

        const videoUrl = normalizeVideoResult(result);
        if (!videoUrl) {
            return res.status(502).json({ error: 'No video URL was returned by the provider.' });
        }

        return res.json({ videoUrl });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Qwen Multi-Angle server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});
