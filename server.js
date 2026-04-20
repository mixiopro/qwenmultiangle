const express = require('express');
const multer = require('multer');
const path = require('path');
const { fal } = require('@fal-ai/client');
let GoogleGenAI = null;

try {
    ({ GoogleGenAI } = require('@google/genai'));
} catch (error) {
    console.warn('[relight] @google/genai is not installed yet. Relight prompt enhancement will be unavailable until it is added.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

const FAL_MODEL_ID = 'fal-ai/qwen-image-edit-2511-multiple-angles';
const NEXT_SCENE_MODEL_ID = 'fal-ai/qwen-image-edit-plus-lora-gallery/next-scene';
const LIGHT_TRANSFER_MODEL_ID = 'fal-ai/qwen-image-edit-2509-lora';
const LIGHT_TRANSFER_FIXED_PROMPT = '参考色调，移除图1原有的光照并参考图2的光照和色调对图1重新照明';
const DEFAULT_LIGHT_TRANSFER_LORA_PATH = 'https://huggingface.co/dx8152/Qwen-Edit-2509-Light-Migration/resolve/main/%E5%8F%82%E8%80%83%E8%89%B2%E8%B0%83.safetensors';
const RELIGHT_MODEL_ID = 'fal-ai/qwen-image-edit-2509-lora';
const RELIGHT_TRIGGER_WORD = '重新照明';
const DEFAULT_RELIGHT_LORA_PATH = 'https://huggingface.co/dx8152/Qwen-Image-Edit-2509-Relight/resolve/main/Qwen-Edit-Relight.safetensors';
const GEMINI_PROMPT_ENHANCER_MODEL_ID = 'gemini-3.1-flash-lite-preview';
const GEMINI_API_KEY = (
    process.env.GEMINI_API_KEY ||
    'AIzaSyC4FRCjh4TmbOUBCc1Ud06PIxZMDGiFqRM'
).trim();
const RELIGHT_PROMPT_ENHANCER_SYSTEM_INSTRUCTION = [
    'You rewrite relighting instructions for the Qwen Image Edit 2509 Relight LoRA.',
    'Rewrite the user input into one short, direct Chinese prompt.',
    'If an image is provided, inspect it for lighting context only and keep the rewrite aligned with the visible lighting situation.',
    'Keep the user intent exactly. Do not add new subjects, scenes, objects, style changes, or details that were not requested.',
    'Keep only lighting-related information such as light source, direction, softness, color temperature, mood, shadows, and reflections.',
    'Use a concise command-like tone similar to "使用窗帘透光（柔和漫射）的光线对图片进行重新照明".',
    'Do not output the trigger word "重新照明"; the backend adds it.',
    'Do not explain, translate literally, or output bullets, quotes, or markdown.',
    'If the request is vague, make the smallest useful rewrite without inventing specifics.',
    'Return only the final Chinese prompt.'
].join('\n');
const geminiClient = GoogleGenAI && GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
    : null;
const DEFAULT_RELIGHT_IMAGE_MIME_TYPE = 'image/jpeg';

if (!GEMINI_API_KEY) {
    console.warn('[relight] GEMINI_API_KEY is not set. English relight instructions cannot be enhanced into Chinese.');
}
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

function normalizeLightTransferLoraScale(value) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
        return 0.75;
    }

    return Math.min(4, Math.max(0, parsedValue));
}

function resolveLightTransferLoraPath() {
    const envPath = typeof process.env.QWEN_LIGHT_TRANSFER_LORA_PATH === 'string'
        ? process.env.QWEN_LIGHT_TRANSFER_LORA_PATH.trim()
        : '';

    return envPath || DEFAULT_LIGHT_TRANSFER_LORA_PATH;
}

function redactImageUrlMarker(url) {
    if (!url || typeof url !== 'string') {
        return 'missing';
    }

    const trimmed = url.trim();
    if (!trimmed) {
        return 'empty';
    }

    try {
        const parsed = new URL(trimmed);
        const fileName = parsed.pathname.split('/').filter(Boolean).pop() || 'file';
        return `${parsed.hostname}/${fileName.slice(0, 24)}`;
    } catch (_) {
        const compact = trimmed.replace(/\s+/g, '');
        return compact.slice(0, 28);
    }
}

function buildLightTransferImageUrls(sourceImageUrl, referenceImageUrl) {
    return [sourceImageUrl, referenceImageUrl];
}

function normalizeImageSize(imageSize) {
    if (!imageSize || typeof imageSize !== 'object') {
        return null;
    }

    const width = Number(imageSize.width);
    const height = Number(imageSize.height);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
    }

    const sanitizedWidth = Math.max(8, Math.floor(width));
    const sanitizedHeight = Math.max(8, Math.floor(height));

    return {
        width: Math.max(8, Math.floor(sanitizedWidth / 8) * 8),
        height: Math.max(8, Math.floor(sanitizedHeight / 8) * 8)
    };
}

function normalizeRelightLoraScale(value) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
        return 0.75;
    }

    return Math.min(4, Math.max(0, parsedValue));
}

function resolveRelightLoraPath() {
    const envPath = typeof process.env.QWEN_RELIGHT_LORA_PATH === 'string'
        ? process.env.QWEN_RELIGHT_LORA_PATH.trim()
        : '';

    return envPath || DEFAULT_RELIGHT_LORA_PATH;
}

function normalizeRelightInstruction(prompt) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!trimmedPrompt) {
        return '';
    }

    return trimmedPrompt.replace(new RegExp(`^${RELIGHT_TRIGGER_WORD}[\\s,，]*`, 'i'), '').trim();
}

function buildRelightPrompt(prompt) {
    const normalizedPrompt = normalizeRelightInstruction(prompt);
    if (!normalizedPrompt) {
        return RELIGHT_TRIGGER_WORD;
    }
    return `${RELIGHT_TRIGGER_WORD},${normalizedPrompt}`;
}

function containsLatinLetters(text) {
    return typeof text === 'string' && /[A-Za-z]/.test(text);
}

function normalizePromptEnhancerOutput(text) {
    if (typeof text !== 'string') {
        return '';
    }

    const firstLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) || '';

    return firstLine
        .replace(/^(中文|提示词|prompt|output|输出)\s*[:：]\s*/i, '')
        .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function inferRelightImageMimeType(imageUrl, contentType) {
    const headerMimeType = typeof contentType === 'string'
        ? contentType.split(';')[0].trim().toLowerCase()
        : '';
    if (headerMimeType.startsWith('image/')) {
        if (headerMimeType === 'image/jpg') {
            return 'image/jpeg';
        }
        return headerMimeType;
    }

    const urlText = typeof imageUrl === 'string' ? imageUrl.trim().toLowerCase() : '';
    if (urlText.startsWith('data:image/')) {
        const match = urlText.match(/^data:([^;]+);base64,/);
        if (match?.[1]) {
            return match[1];
        }
    }

    if (urlText.endsWith('.png')) return 'image/png';
    if (urlText.endsWith('.webp')) return 'image/webp';
    if (urlText.endsWith('.gif')) return 'image/gif';
    if (urlText.endsWith('.jpg') || urlText.endsWith('.jpeg')) return 'image/jpeg';

    return DEFAULT_RELIGHT_IMAGE_MIME_TYPE;
}

function parseDataUrlImagePart(imageUrl) {
    if (typeof imageUrl !== 'string') {
        return null;
    }

    const match = imageUrl.trim().match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) {
        return null;
    }

    return {
        inlineData: {
            mimeType: match[1] === 'image/jpg' ? 'image/jpeg' : match[1],
            data: match[2]
        }
    };
}

async function fetchRelightImagePart(imageUrl) {
    const trimmedImageUrl = typeof imageUrl === 'string' ? imageUrl.trim() : '';
    if (!trimmedImageUrl) {
        return null;
    }

    const dataUrlPart = parseDataUrlImagePart(trimmedImageUrl);
    if (dataUrlPart) {
        return dataUrlPart;
    }

    const response = await fetch(trimmedImageUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch relight image (${response.status} ${response.statusText})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(arrayBuffer).toString('base64'),
            mimeType: inferRelightImageMimeType(trimmedImageUrl, response.headers.get('content-type'))
        }
    };
}

async function enhanceRelightPrompt(prompt, imageUrl) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!trimmedPrompt) {
        return {
            enhancedPrompt: '',
            usedImageContext: false,
            usedFallback: false,
            fallbackReason: ''
        };
    }

    if (!geminiClient) {
        return {
            enhancedPrompt: trimmedPrompt,
            usedImageContext: false,
            usedFallback: true,
            fallbackReason: 'Gemini client is not configured.'
        };
    }

    let imagePart = null;
    let imageContextAvailable = false;

    try {
        imagePart = await fetchRelightImagePart(imageUrl);
        imageContextAvailable = Boolean(imagePart);
    } catch (error) {
        console.warn('[relight] Failed to attach image context to prompt enhancer. Falling back to text-only enhancement.', error?.message || error);
    }

    try {
        const response = await geminiClient.models.generateContent({
            model: GEMINI_PROMPT_ENHANCER_MODEL_ID,
            contents: [
                {
                    role: 'user',
                    parts: [
                        ...(imagePart ? [imagePart] : []),
                        {
                            text: trimmedPrompt
                        }
                    ]
                }
            ],
            config: {
                systemInstruction: RELIGHT_PROMPT_ENHANCER_SYSTEM_INSTRUCTION,
                thinkingConfig: {
                    thinkingLevel: 'MINIMAL'
                },
                maxOutputTokens: 64
            }
        });

        const enhancedPrompt = normalizePromptEnhancerOutput(response?.text || '');
        if (!enhancedPrompt) {
            return {
                enhancedPrompt: trimmedPrompt,
                usedImageContext: imageContextAvailable,
                usedFallback: true,
                fallbackReason: 'Prompt enhancer returned an empty response.'
            };
        }

        const normalizedEnhancedPrompt = normalizeRelightInstruction(enhancedPrompt) || enhancedPrompt;
        return {
            enhancedPrompt: normalizedEnhancedPrompt,
            usedImageContext: imageContextAvailable,
            usedFallback: false,
            fallbackReason: ''
        };
    } catch (error) {
        console.warn('[relight] enhanceRelightPrompt failed. Falling back to the original prompt.', error?.message || error);
        return {
            enhancedPrompt: trimmedPrompt,
            usedImageContext: imageContextAvailable,
            usedFallback: true,
            fallbackReason: error?.message || 'Prompt enhancer failed.'
        };
    }
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

app.post('/api/generate-light-transfer', async (req, res) => {
    try {
        const { sourceImageUrl, referenceImageUrl, imageSize, loraScale } = req.body || {};

        if (!sourceImageUrl) {
            return res.status(400).json({ error: 'sourceImageUrl is required.' });
        }

        if (!referenceImageUrl) {
            return res.status(400).json({ error: 'referenceImageUrl is required.' });
        }

        const imageUrls = buildLightTransferImageUrls(sourceImageUrl, referenceImageUrl);
        const normalizedImageSize = normalizeImageSize(imageSize);
        const submitDebug = {
            inputOrder: ['source', 'reference'],
            sourceMarker: redactImageUrlMarker(sourceImageUrl),
            referenceMarker: redactImageUrlMarker(referenceImageUrl),
            imageSize: normalizedImageSize || null
        };
        console.info('[light-transfer] submit payload mapping', submitDebug);
        const queueRequest = await fal.queue.submit(LIGHT_TRANSFER_MODEL_ID, {
            input: {
                prompt: LIGHT_TRANSFER_FIXED_PROMPT,
                image_urls: imageUrls,
                ...(normalizedImageSize ? { image_size: normalizedImageSize } : {}),
                loras: [
                    {
                        path: resolveLightTransferLoraPath(),
                        scale: normalizeLightTransferLoraScale(loraScale)
                    }
                ]
            }
        });

        const requestId = queueRequest?.request_id || queueRequest?.requestId;
        if (!requestId) {
            return res.status(502).json({ error: 'No request ID was returned by the provider.' });
        }

        return res.status(202).json({
            requestId,
            status: 'queued',
            pollUrl: `/api/generate-light-transfer/${requestId}`,
            inputOrder: submitDebug.inputOrder,
            sourceMarker: submitDebug.sourceMarker,
            referenceMarker: submitDebug.referenceMarker,
            imageSize: submitDebug.imageSize
        });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.get('/api/generate-light-transfer/:requestId', async (req, res) => {
    try {
        const requestId = req.params?.requestId;
        if (!requestId) {
            return res.status(400).json({ error: 'requestId is required.' });
        }

        const queueStatus = await fal.queue.status(LIGHT_TRANSFER_MODEL_ID, {
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
                const result = await fal.queue.result(LIGHT_TRANSFER_MODEL_ID, { requestId });
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
                const message = body?.detail || body?.message || error?.message || 'Light transfer generation failed.';

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
            error: typeof fallbackMessage === 'string' ? fallbackMessage : 'Light transfer generation failed.',
            detail: queueStatus || null
        });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.post('/api/generate-relight', async (req, res) => {
    try {
        const { imageUrl, prompt, loraScale } = req.body || {};

        if (!imageUrl) {
            return res.status(400).json({ error: 'imageUrl is required.' });
        }

        const enhancementResult = await enhanceRelightPrompt(prompt, imageUrl);
        const enhancedPrompt = enhancementResult?.enhancedPrompt || '';
        if (!enhancedPrompt) {
            return res.status(400).json({ error: 'A relight instruction is required.' });
        }

        const originalPrompt = typeof prompt === 'string' ? prompt.trim() : '';
        if (enhancementResult?.usedFallback && containsLatinLetters(enhancedPrompt) && containsLatinLetters(originalPrompt)) {
            return res.status(422).json({
                error: enhancementResult?.fallbackReason || 'Relight prompt enhancement failed. Please retry.',
                detail: {
                    enhancedPrompt,
                    usedImageContext: Boolean(enhancementResult?.usedImageContext),
                    usedFallback: true
                }
            });
        }

        const finalPrompt = buildRelightPrompt(enhancedPrompt);

        const queueRequest = await fal.queue.submit(RELIGHT_MODEL_ID, {
            input: {
                prompt: finalPrompt,
                image_urls: [imageUrl],
                loras: [
                    {
                        path: resolveRelightLoraPath(),
                        scale: normalizeRelightLoraScale(loraScale)
                    }
                ]
            }
        });

        const requestId = queueRequest?.request_id || queueRequest?.requestId;
        if (!requestId) {
            return res.status(502).json({ error: 'No request ID was returned by the provider.' });
        }

        return res.status(202).json({
            requestId,
            status: 'queued',
            pollUrl: `/api/generate-relight/${requestId}`,
            prompt: finalPrompt,
            enhancedPrompt,
            usedImageContext: Boolean(enhancementResult?.usedImageContext),
            usedFallback: Boolean(enhancementResult?.usedFallback),
            fallbackReason: enhancementResult?.fallbackReason || ''
        });
    } catch (error) {
        return sendApiError(res, error);
    }
});

app.get('/api/generate-relight/:requestId', async (req, res) => {
    try {
        const requestId = req.params?.requestId;
        if (!requestId) {
            return res.status(400).json({ error: 'requestId is required.' });
        }

        const queueStatus = await fal.queue.status(RELIGHT_MODEL_ID, {
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
                const result = await fal.queue.result(RELIGHT_MODEL_ID, { requestId });
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
                const message = body?.detail || body?.message || error?.message || 'Relight generation failed.';

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
            error: typeof fallbackMessage === 'string' ? fallbackMessage : 'Relight generation failed.',
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
