// ===== Configuration =====
const CONFIG = {
    MAX_SEED: 2147483647,
    MAX_WAYPOINTS: 4,
    MIN_WAYPOINTS: 2
};

// ===== Camera Angle Labels (for UI display only) =====
// Based on fal.ai API documentation

// horizontal_angle: 0-360 (0=front, 90=right, 180=back, 270=left)
function getAzimuthLabel(deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg <= 22.5 || deg > 337.5) return 'Front';
    if (deg <= 67.5) return 'Front-Right';
    if (deg <= 112.5) return 'Right';
    if (deg <= 157.5) return 'Back-Right';
    if (deg <= 202.5) return 'Back';
    if (deg <= 247.5) return 'Back-Left';
    if (deg <= 292.5) return 'Left';
    return 'Front-Left';
}

// ===== State =====
let state = {
    azimuth: 0,       // horizontal_angle: 0-360 (0=front, 90=right, 180=back, 270=left)
    elevation: 0,     // vertical_angle: -30 to 90 (-30=low-angle, 0=eye-level, 30=elevated, 60=high-angle, 90=bird's-eye)
    distance: 5,      // zoom: 0-10 (0=far/wide, 5=medium, 10=close-up)
    uploadedImage: null,
    uploadedImageBase64: null,
    imageUrl: null,   // Direct URL (no upload needed)
    isGenerating: false
};

// ===== Path State =====
let pathState = {
    waypoints: [],           // Array of {id, azimuth, elevation, distance, generatedImageUrl}
    uploadedImage: null,
    uploadedImageBase64: null,
    imageUrl: null,
    sourceImageUrl: null,    // Resolved URL used as the base input image (for video start frame)
    isGeneratingKeyframes: false,
    isGeneratingVideos: false,
    generatedVideoUrl: null,
    generatedVideoBlob: null,
    generatedVideoUrlMp4: null,
    generatedVideoBlobMp4: null,
    videoMode: 'quick'       // 'quick' or 'ai'
};

// ===== Next Scene State =====
let nextSceneState = {
    uploadedImage: null,
    uploadedImageBase64: null,
    imageUrl: null,
    sourceImageUrl: null,
    isGenerating: false,
    activeRequestId: null,
    runToken: 0
};

// ===== Light Transfer State =====
let lightTransferState = {
    sourceUploadedImage: null,
    sourceUploadedImageBase64: null,
    sourceImageUrl: null,
    sourceResolvedImageUrl: null,
    referenceUploadedImage: null,
    referenceUploadedImageBase64: null,
    referenceImageUrl: null,
    referenceResolvedImageUrl: null,
    isGenerating: false,
    activeRequestId: null,
    runToken: 0
};

// ===== Gaussian Splash State =====
let gaussianSplashState = {
    uploadedImage: null,
    uploadedImageBase64: null,
    imageUrl: null,
    sourceImageUrl: null,
    isGenerating: false,
    activeRequestId: null,
    runToken: 0
};

// ===== DOM Elements =====
const elements = {};
const pathElements = {};
const nextSceneElements = {};
const lightTransferElements = {};
const gaussianSplashElements = {};

// ===== Seedance Segment Cache (localStorage) =====
const AI_SEGMENTS_CACHE_KEY = 'qwenmultiangle_ai_segments_cache_v1';
const AI_SEGMENTS_CACHE_MAX_ENTRIES = 15;

function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch (_) { return fallback; }
}

function loadAICache() {
    const raw = localStorage.getItem(AI_SEGMENTS_CACHE_KEY);
    const data = safeJsonParse(raw, {});
    if (!data || typeof data !== 'object') return {};
    return data;
}

function saveAICache(cacheObj) {
    try {
        localStorage.setItem(AI_SEGMENTS_CACHE_KEY, JSON.stringify(cacheObj));
    } catch (e) {
        // If storage is full, best-effort: clear cache
        try { localStorage.removeItem(AI_SEGMENTS_CACHE_KEY); } catch (_) {}
    }
}

function pruneAICache(cacheObj) {
    const entries = Object.entries(cacheObj || {});
    if (entries.length <= AI_SEGMENTS_CACHE_MAX_ENTRIES) return cacheObj;
    // Sort by createdAt desc, keep newest N
    entries.sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0));
    const pruned = {};
    entries.slice(0, AI_SEGMENTS_CACHE_MAX_ENTRIES).forEach(([k, v]) => { pruned[k] = v; });
    return pruned;
}

function hashStringFNV1a(input) {
    // Small, deterministic hash for cache keys (not crypto)
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // unsigned
    return (h >>> 0).toString(16);
}

function buildSeedanceSegmentsCacheKey({ keyframeUrls, prompt, resolution, seedanceSeconds, loop, modelKey }) {
    // IMPORTANT: do NOT include per-pair seconds here (so you can re-stitch without re-generating)
    const payload = JSON.stringify({
        keyframeUrls,
        prompt,
        resolution,
        seedanceSeconds,
        loop: !!loop,
        modelKey: modelKey || 'seedance'
    });
    return `seg_${hashStringFNV1a(payload)}`;
}


// ===== MP4 Transcoding (ffmpeg.wasm) =====
let _ffmpegCtx = null;
async function getFfmpegCtx() {
    if (_ffmpegCtx) return _ffmpegCtx;

    // Lazy-load only when needed (MP4 output)
    const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
        import('https://esm.sh/@ffmpeg/ffmpeg@0.12.10'),
        import('https://esm.sh/@ffmpeg/util@0.12.1')
    ]);

    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
    });

    _ffmpegCtx = { ffmpeg, fetchFile };
    return _ffmpegCtx;
}

async function transcodeWebmToMp4(webmBlob, logPrefix = 'MP4') {
    addPathLog(`${logPrefix}: Loading ffmpeg... (first time can take ~10-30s)`, 'info');
    const { ffmpeg, fetchFile } = await getFfmpegCtx();

    // Clean up old files if any
    try { await ffmpeg.deleteFile('in.webm'); } catch (_) {}
    try { await ffmpeg.deleteFile('out.mp4'); } catch (_) {}

    await ffmpeg.writeFile('in.webm', await fetchFile(webmBlob));

    // Try H.264 first (best compatibility). If not available in the wasm build, fall back to MPEG-4.
    try {
        addPathLog(`${logPrefix}: Transcoding to H.264 MP4...`, 'info');
        await ffmpeg.exec([
            '-i', 'in.webm',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            'out.mp4'
        ]);
    } catch (e1) {
        addPathLog(`${logPrefix}: H.264 codec unavailable; falling back to MPEG-4...`, 'warn');
        await ffmpeg.exec([
            '-i', 'in.webm',
            '-c:v', 'mpeg4',
            '-q:v', '4',
            '-movflags', '+faststart',
            'out.mp4'
        ]);
    }

    const data = await ffmpeg.readFile('out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
}

// ===== Utility Functions =====
function snapToNearest(value, options) {
    return options.reduce((prev, curr) => 
        Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
    );
}


function updatePromptDisplay() {
    // Show the numeric parameters that will be sent to the API
    const azLabel = getAzimuthLabel(state.azimuth);
    const elLabel = getElevationLabelFromAngle(state.elevation);
    const zoomLabel = getZoomLabel(state.distance);
    
    elements.promptDisplay.innerHTML = `
        <div class="param-display">
            <span class="param-name">horizontal_angle:</span> <span class="param-value">${state.azimuth}°</span> <span class="param-label">(${azLabel})</span>
        </div>
        <div class="param-display">
            <span class="param-name">vertical_angle:</span> <span class="param-value">${state.elevation}°</span> <span class="param-label">(${elLabel})</span>
        </div>
        <div class="param-display">
            <span class="param-name">zoom:</span> <span class="param-value">${state.distance}</span> <span class="param-label">(${zoomLabel})</span>
        </div>
    `;
}

// Get elevation label from actual angle (-30 to 90)
function getElevationLabelFromAngle(deg) {
    if (deg <= -15) return 'Low-angle (looking up)';
    if (deg <= 15) return 'Eye-level';
    if (deg <= 45) return 'Elevated';
    if (deg <= 75) return 'High-angle';
    return 'Bird\'s-eye (looking down)';
}

// Get zoom label (0-10)
function getZoomLabel(val) {
    if (val <= 2) return 'Wide shot (far)';
    if (val <= 4) return 'Medium-wide';
    if (val <= 6) return 'Medium shot';
    if (val <= 8) return 'Medium close-up';
    return 'Close-up (very close)';
}

function updateSliderValues() {
    elements.azimuthValue.textContent = `${Math.round(state.azimuth)}°`;
    elements.elevationValue.textContent = `${Math.round(state.elevation)}°`;
    elements.distanceValue.textContent = state.distance.toFixed(1);
}

function updateGenerateButton() {
    const hasImage = state.uploadedImage !== null || state.imageUrl !== null;
    elements.generateBtn.disabled = !hasImage || state.isGenerating;
}

function updateNextSceneButton() {
    const hasImage = nextSceneState.uploadedImage !== null || nextSceneState.imageUrl !== null;
    const hasPrompt = !!nextSceneElements.prompt?.value?.trim();
    if (nextSceneElements.generateBtn) {
        nextSceneElements.generateBtn.disabled = !hasImage || !hasPrompt || nextSceneState.isGenerating;
    }
}

function updateLightTransferButton() {
    const hasSource = lightTransferState.sourceUploadedImage !== null || lightTransferState.sourceImageUrl !== null;
    const hasReference = lightTransferState.referenceUploadedImage !== null || lightTransferState.referenceImageUrl !== null;
    if (lightTransferElements.generateBtn) {
        lightTransferElements.generateBtn.disabled = !hasSource || !hasReference || lightTransferState.isGenerating;
    }
}

function updateGaussianSplashButton() {
    const hasImage = gaussianSplashState.uploadedImage !== null || gaussianSplashState.imageUrl !== null;
    if (gaussianSplashElements.generateBtn) {
        gaussianSplashElements.generateBtn.disabled = !hasImage || gaussianSplashState.isGenerating;
    }
}

function showStatus(message, type = 'info') {
    elements.statusMessage.textContent = message;
    elements.statusMessage.className = `status-message ${type}`;
    elements.statusMessage.classList.remove('hidden');

    if (type === 'success') {
        setTimeout(() => {
            elements.statusMessage.classList.add('hidden');
        }, 5000);
    }
}

function hideStatus() {
    elements.statusMessage.classList.add('hidden');
}

function showNextSceneStatus(message, type = 'info') {
    const el = nextSceneElements.statusMessage;
    if (!el) return;
    el.textContent = message;
    el.className = `status-message ${type}`;
    el.classList.remove('hidden');
    if (type === 'success') {
        setTimeout(() => el.classList.add('hidden'), 5000);
    }
}

function hideNextSceneStatus() {
    nextSceneElements.statusMessage?.classList.add('hidden');
}

function showLightTransferStatus(message, type = 'info') {
    const el = lightTransferElements.statusMessage;
    if (!el) return;
    el.textContent = message;
    el.className = `status-message ${type}`;
    el.classList.remove('hidden');
    if (type === 'success') {
        setTimeout(() => el.classList.add('hidden'), 5000);
    }
}

function hideLightTransferStatus() {
    lightTransferElements.statusMessage?.classList.add('hidden');
}

function showGaussianSplashStatus(message, type = 'info') {
    const el = gaussianSplashElements.statusMessage;
    if (!el) return;
    el.textContent = message;
    el.className = `status-message ${type}`;
    el.classList.remove('hidden');
    if (type === 'success') {
        setTimeout(() => el.classList.add('hidden'), 5000);
    }
}

function hideGaussianSplashStatus() {
    gaussianSplashElements.statusMessage?.classList.add('hidden');
}

// ===== Logging System =====
function getTimestamp() {
    const now = new Date();
    return now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addLog(message, type = 'info') {
    if (!elements.logsContainer) return;
    
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = `[${getTimestamp()}]`;
    
    entry.appendChild(timestamp);
    
    // Handle objects
    let messageText = message;
    if (typeof message === 'object') {
        try {
            messageText = JSON.stringify(message, null, 2);
        } catch (e) {
            messageText = String(message);
        }
    }
    
    entry.appendChild(document.createTextNode(messageText));
    elements.logsContainer.appendChild(entry);
    
    // Auto-scroll to bottom
    elements.logsContainer.scrollTop = elements.logsContainer.scrollHeight;
}

function clearLogs() {
    if (elements.logsContainer) {
        elements.logsContainer.innerHTML = '<div class="log-entry info">Logs cleared.</div>';
    }
}

function addNextSceneLog(message, type = 'info') {
    const container = nextSceneElements.logsContainer;
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = `[${getTimestamp()}]`;
    entry.appendChild(timestamp);

    let messageText = message;
    if (typeof message === 'object') {
        try {
            messageText = JSON.stringify(message, null, 2);
        } catch (e) {
            messageText = String(message);
        }
    }

    entry.appendChild(document.createTextNode(messageText));
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
}

function clearNextSceneLogs() {
    if (nextSceneElements.logsContainer) {
        nextSceneElements.logsContainer.innerHTML = '<div class="log-entry info">Logs cleared.</div>';
    }
}

function addLightTransferLog(message, type = 'info') {
    const container = lightTransferElements.logsContainer;
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = `[${getTimestamp()}]`;
    entry.appendChild(timestamp);

    let messageText = message;
    if (typeof message === 'object') {
        try {
            messageText = JSON.stringify(message, null, 2);
        } catch (e) {
            messageText = String(message);
        }
    }

    entry.appendChild(document.createTextNode(messageText));
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
}

function clearLightTransferLogs() {
    if (lightTransferElements.logsContainer) {
        lightTransferElements.logsContainer.innerHTML = '<div class="log-entry info">Logs cleared.</div>';
    }
}

function addGaussianSplashLog(message, type = 'info') {
    const container = gaussianSplashElements.logsContainer;
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = `[${getTimestamp()}]`;
    entry.appendChild(timestamp);

    let messageText = message;
    if (typeof message === 'object') {
        try {
            messageText = JSON.stringify(message, null, 2);
        } catch (e) {
            messageText = String(message);
        }
    }

    entry.appendChild(document.createTextNode(messageText));
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
}

function clearGaussianSplashLogs() {
    if (gaussianSplashElements.logsContainer) {
        gaussianSplashElements.logsContainer.innerHTML = '<div class="log-entry info">Logs cleared.</div>';
    }
}

function formatError(error) {
    if (!error) return 'Unknown error';
    
    if (typeof error === 'string') return error;
    
    // Handle Error instances
    if (error instanceof Error) {
        return error.message || error.toString();
    }
    
    if (typeof error === 'object') {
        // Try common API error properties (fal.ai specific)
        if (error.detail) {
            if (typeof error.detail === 'string') return error.detail;
            if (Array.isArray(error.detail)) {
                return error.detail.map(d => d.msg || d.message || JSON.stringify(d)).join(', ');
            }
            if (typeof error.detail === 'object') {
                return error.detail.message || error.detail.msg || JSON.stringify(error.detail);
            }
        }
        if (error.message) return error.message;
        if (error.msg) return error.msg;
        if (error.error) {
            if (typeof error.error === 'string') return error.error;
            if (error.error.message) return error.error.message;
            return JSON.stringify(error.error);
        }
        if (error.statusText) return error.statusText;
        
        // Fallback to JSON
        try {
            const jsonStr = JSON.stringify(error, null, 2);
            // Don't return [object Object]
            if (jsonStr === '{}') return 'Empty error response';
            return jsonStr;
        } catch (e) {
            return 'Error: Unable to parse error details';
        }
    }
    
    return String(error);
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ===== Three.js Scene Setup =====
let threeScene = null;

function initThreeJS() {
    const container = elements.threejsContainer;
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Scene with gradient-like background
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);
    
    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(4, 3.5, 4);
    camera.lookAt(0, 0.3, 0);
    
    // Renderer with better settings
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    
    // Lighting - more dramatic
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);
    
    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
    mainLight.position.set(5, 10, 5);
    scene.add(mainLight);
    
    const fillLight = new THREE.DirectionalLight(0xE93D82, 0.3);
    fillLight.position.set(-5, 5, -5);
    scene.add(fillLight);
    
    // Stylish grid
    const gridHelper = new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);
    
    // Constants
    const CENTER = new THREE.Vector3(0, 0.5, 0);
    const AZIMUTH_RADIUS = 1.8;
    const ELEVATION_RADIUS = 1.4;
    
    // Live values
    let liveAzimuth = state.azimuth;
    let liveElevation = state.elevation;
    let liveDistance = state.distance;
    
    // ===== Subject (Image Plane) =====
    // Like original: just position at CENTER, no rotation (faces +Z by default)
    const planeGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const planeMat = new THREE.MeshBasicMaterial({ 
        color: 0x3a3a4a,
        side: THREE.DoubleSide
    });
    const imagePlane = new THREE.Mesh(planeGeo, planeMat);
    imagePlane.position.copy(CENTER);
    scene.add(imagePlane);
    
    // Add a visible border/frame
    const frameGeo = new THREE.EdgesGeometry(planeGeo);
    const frameMat = new THREE.LineBasicMaterial({ color: 0xE93D82 });
    const imageFrame = new THREE.LineSegments(frameGeo, frameMat);
    imageFrame.position.copy(CENTER);
    scene.add(imageFrame);
    
    // Glow ring around subject (on the ground plane)
    const glowRingGeo = new THREE.RingGeometry(0.55, 0.58, 64);
    const glowRingMat = new THREE.MeshBasicMaterial({ 
        color: 0xE93D82, 
        transparent: true, 
        opacity: 0.4,
        side: THREE.DoubleSide
    });
    const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
    glowRing.position.set(0, 0.01, 0); // On the ground
    glowRing.rotation.x = -Math.PI / 2; // Flat on ground
    scene.add(glowRing);
    
    // ===== Camera Indicator - Stylish pyramid =====
    const camGeo = new THREE.ConeGeometry(0.15, 0.4, 4);
    const camMat = new THREE.MeshStandardMaterial({ 
        color: 0xE93D82,
        emissive: 0xE93D82,
        emissiveIntensity: 0.5,
        metalness: 0.8,
        roughness: 0.2
    });
    const cameraIndicator = new THREE.Mesh(camGeo, camMat);
    scene.add(cameraIndicator);
    
    // Camera glow sphere
    const camGlowGeo = new THREE.SphereGeometry(0.08, 16, 16);
    const camGlowMat = new THREE.MeshBasicMaterial({ 
        color: 0xff6ba8,
        transparent: true,
        opacity: 0.8
    });
    const camGlow = new THREE.Mesh(camGlowGeo, camGlowMat);
    scene.add(camGlow);
    
    // ===== Azimuth Ring - Thick and bright =====
    const azRingGeo = new THREE.TorusGeometry(AZIMUTH_RADIUS, 0.04, 16, 100);
    const azRingMat = new THREE.MeshBasicMaterial({ 
        color: 0xE93D82,
        transparent: true,
        opacity: 0.7
    });
    const azimuthRing = new THREE.Mesh(azRingGeo, azRingMat);
    azimuthRing.rotation.x = Math.PI / 2;
    azimuthRing.position.y = 0.02;
    scene.add(azimuthRing);
    
    // Azimuth handle - Glowing orb
    const azHandleGeo = new THREE.SphereGeometry(0.16, 32, 32);
    const azHandleMat = new THREE.MeshStandardMaterial({ 
        color: 0xE93D82,
        emissive: 0xE93D82,
        emissiveIntensity: 0.6,
        metalness: 0.3,
        roughness: 0.4
    });
    const azimuthHandle = new THREE.Mesh(azHandleGeo, azHandleMat);
    scene.add(azimuthHandle);
    
    // Azimuth handle outer glow
    const azGlowGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const azGlowMat = new THREE.MeshBasicMaterial({ 
        color: 0xE93D82,
        transparent: true,
        opacity: 0.2
    });
    const azGlow = new THREE.Mesh(azGlowGeo, azGlowMat);
    scene.add(azGlow);
    
    // ===== Elevation Arc - Built from curve points (like original) =====
    // Fixed position at X = -0.8, arc goes from -30° to 90°
    const ELEV_ARC_X = -0.8;
    const arcPoints = [];
    for (let i = 0; i <= 32; i++) {
        const angle = (-30 + (120 * i / 32)) * Math.PI / 180; // -30° to 90°
        arcPoints.push(new THREE.Vector3(
            ELEV_ARC_X,
            ELEVATION_RADIUS * Math.sin(angle) + CENTER.y,
            ELEVATION_RADIUS * Math.cos(angle)
        ));
    }
    const arcCurve = new THREE.CatmullRomCurve3(arcPoints);
    const elArcGeo = new THREE.TubeGeometry(arcCurve, 32, 0.04, 8, false);
    const elArcMat = new THREE.MeshBasicMaterial({ 
        color: 0x00FFD0,
        transparent: true,
        opacity: 0.8
    });
    const elevationArc = new THREE.Mesh(elArcGeo, elArcMat);
    scene.add(elevationArc);
    
    // Elevation handle - Glowing orb
    const elHandleGeo = new THREE.SphereGeometry(0.16, 32, 32);
    const elHandleMat = new THREE.MeshStandardMaterial({ 
        color: 0x00FFD0,
        emissive: 0x00FFD0,
        emissiveIntensity: 0.6,
        metalness: 0.3,
        roughness: 0.4
    });
    const elevationHandle = new THREE.Mesh(elHandleGeo, elHandleMat);
    scene.add(elevationHandle);
    
    // Elevation handle outer glow
    const elGlowGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const elGlowMat = new THREE.MeshBasicMaterial({ 
        color: 0x00FFD0,
        transparent: true,
        opacity: 0.2
    });
    const elGlow = new THREE.Mesh(elGlowGeo, elGlowMat);
    scene.add(elGlow);
    
    // ===== Distance Handle - Golden orb =====
    const distHandleGeo = new THREE.SphereGeometry(0.15, 32, 32);
    const distHandleMat = new THREE.MeshStandardMaterial({ 
        color: 0xFFB800,
        emissive: 0xFFB800,
        emissiveIntensity: 0.7,
        metalness: 0.5,
        roughness: 0.3
    });
    const distanceHandle = new THREE.Mesh(distHandleGeo, distHandleMat);
    scene.add(distanceHandle);
    
    // Distance handle outer glow
    const distGlowGeo = new THREE.SphereGeometry(0.22, 16, 16);
    const distGlowMat = new THREE.MeshBasicMaterial({ 
        color: 0xFFB800,
        transparent: true,
        opacity: 0.25
    });
    const distGlow = new THREE.Mesh(distGlowGeo, distGlowMat);
    scene.add(distGlow);
    
    // Distance line - Thick glowing line (using tube)
    let distanceTube = null;
    function updateDistanceLine(start, end) {
        if (distanceTube) scene.remove(distanceTube);
        const path = new THREE.LineCurve3(start, end);
        const tubeGeo = new THREE.TubeGeometry(path, 1, 0.025, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({ 
            color: 0xFFB800,
            transparent: true,
            opacity: 0.8
        });
        distanceTube = new THREE.Mesh(tubeGeo, tubeMat);
        scene.add(distanceTube);
    }
    
    // ===== Projection Guide Lines (dotted) =====
    // Vertical line: Camera down to azimuth ring (shows XZ projection)
    const verticalGuideGeo = new THREE.BufferGeometry();
    const verticalGuideMat = new THREE.LineDashedMaterial({
        color: 0xE93D82,
        dashSize: 0.1,
        gapSize: 0.05,
        transparent: true,
        opacity: 0.6
    });
    const verticalGuide = new THREE.Line(verticalGuideGeo, verticalGuideMat);
    scene.add(verticalGuide);
    
    // Horizontal line: Ground projection to center (shows azimuth direction)
    const horizontalGuideGeo = new THREE.BufferGeometry();
    const horizontalGuideMat = new THREE.LineDashedMaterial({
        color: 0xE93D82,
        dashSize: 0.1,
        gapSize: 0.05,
        transparent: true,
        opacity: 0.6
    });
    const horizontalGuide = new THREE.Line(horizontalGuideGeo, horizontalGuideMat);
    scene.add(horizontalGuide);
    
    // Elevation projection line: Camera to elevation arc plane
    const elevationGuideGeo = new THREE.BufferGeometry();
    const elevationGuideMat = new THREE.LineDashedMaterial({
        color: 0x00FFD0,
        dashSize: 0.1,
        gapSize: 0.05,
        transparent: true,
        opacity: 0.6
    });
    const elevationGuide = new THREE.Line(elevationGuideGeo, elevationGuideMat);
    scene.add(elevationGuide);
    
    // Small sphere at ground projection point
    const groundMarkerGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const groundMarkerMat = new THREE.MeshBasicMaterial({ 
        color: 0xE93D82,
        transparent: true,
        opacity: 0.7
    });
    const groundMarker = new THREE.Mesh(groundMarkerGeo, groundMarkerMat);
    scene.add(groundMarker);
    
    // ===== Update Visual Positions =====
    function updateVisuals() {
        const azRad = (liveAzimuth * Math.PI) / 180;
        const elRad = (liveElevation * Math.PI) / 180;
        // Zoom: 0=wide (far), 10=close-up (near)
        // Make the movement MORE dramatic: 0.6 to 2.6 range
        // Higher zoom = camera closer to subject visually
        const visualDist = 2.6 - (liveDistance / 10) * 2.0;
        
        // Camera indicator
        const camX = visualDist * Math.sin(azRad) * Math.cos(elRad);
        const camY = CENTER.y + visualDist * Math.sin(elRad);
        const camZ = visualDist * Math.cos(azRad) * Math.cos(elRad);
        
        cameraIndicator.position.set(camX, camY, camZ);
        cameraIndicator.lookAt(CENTER);
        cameraIndicator.rotateX(Math.PI / 2);
        
        camGlow.position.copy(cameraIndicator.position);
        
        // Azimuth handle
        const azX = AZIMUTH_RADIUS * Math.sin(azRad);
        const azZ = AZIMUTH_RADIUS * Math.cos(azRad);
        azimuthHandle.position.set(azX, 0.16, azZ);
        azGlow.position.copy(azimuthHandle.position);
        
        // Elevation arc is at fixed position (no rotation needed)
        // Elevation handle - on the arc at current elevation (same formula as arc points)
        const elY = CENTER.y + ELEVATION_RADIUS * Math.sin(elRad);
        const elZ = ELEVATION_RADIUS * Math.cos(elRad);
        elevationHandle.position.set(ELEV_ARC_X, elY, elZ);
        elGlow.position.copy(elevationHandle.position);
        
        // Distance handle - ON the golden line between center and camera
        // Higher zoom (10) = closer to subject = handle closer to center
        // Lower zoom (0) = farther from subject = handle closer to camera
        const distT = 0.15 + ((10 - liveDistance) / 10) * 0.7;
        distanceHandle.position.lerpVectors(CENTER, cameraIndicator.position, distT);
        distGlow.position.copy(distanceHandle.position);
        
        // Distance line from center to camera
        updateDistanceLine(CENTER.clone(), cameraIndicator.position.clone());
        
        // ===== Update Projection Guide Lines =====
        // Ground projection point (camera position projected to azimuth ring height)
        const groundProjection = new THREE.Vector3(camX, 0.05, camZ);
        groundMarker.position.copy(groundProjection);
        
        // Vertical guide: Camera -> Ground projection
        verticalGuideGeo.setFromPoints([
            cameraIndicator.position.clone(),
            groundProjection.clone()
        ]);
        verticalGuide.computeLineDistances();
        
        // Horizontal guide: Ground projection -> Center (at ground level)
        const centerGround = new THREE.Vector3(0, 0.05, 0);
        horizontalGuideGeo.setFromPoints([
            groundProjection.clone(),
            centerGround.clone()
        ]);
        horizontalGuide.computeLineDistances();
        
        // Elevation guide: Camera -> point on elevation arc at same height
        // This shows the horizontal projection to the elevation arc
        const elevArcPoint = new THREE.Vector3(ELEV_ARC_X, camY, elZ);
        elevationGuideGeo.setFromPoints([
            cameraIndicator.position.clone(),
            elevArcPoint.clone()
        ]);
        elevationGuide.computeLineDistances();
        
        // Animate glow ring (rotating on ground)
        glowRing.rotation.z += 0.005;
    }
    
    updateVisuals();
    
    // ===== Raycaster for Interaction =====
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let isDragging = false;
    let dragTarget = null;
    let hoveredHandle = null;
    
    function getMousePos(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }
    
    function setHandleScale(handle, glow, scale) {
        handle.scale.setScalar(scale);
        if (glow) glow.scale.setScalar(scale);
    }
    
    function onPointerDown(event) {
        getMousePos(event);
        raycaster.setFromCamera(mouse, camera);
        
        const handles = [
            { mesh: azimuthHandle, glow: azGlow, name: 'azimuth' },
            { mesh: elevationHandle, glow: elGlow, name: 'elevation' },
            { mesh: distanceHandle, glow: distGlow, name: 'distance' }
        ];
        
        for (const h of handles) {
            if (raycaster.intersectObject(h.mesh).length > 0) {
                isDragging = true;
                dragTarget = h.name;
                setHandleScale(h.mesh, h.glow, 1.3);
                renderer.domElement.style.cursor = 'grabbing';
                return;
            }
        }
    }
    
    function onPointerMove(event) {
        getMousePos(event);
        raycaster.setFromCamera(mouse, camera);
        
        if (!isDragging) {
            // Hover effects
            const handles = [
                { mesh: azimuthHandle, glow: azGlow, name: 'azimuth' },
                { mesh: elevationHandle, glow: elGlow, name: 'elevation' },
                { mesh: distanceHandle, glow: distGlow, name: 'distance' }
            ];
            
            let foundHover = null;
            for (const h of handles) {
                if (raycaster.intersectObject(h.mesh).length > 0) {
                    foundHover = h;
                    break;
                }
            }
            
            // Reset previous hover
            if (hoveredHandle && hoveredHandle !== foundHover) {
                setHandleScale(hoveredHandle.mesh, hoveredHandle.glow, 1.0);
            }
            
            if (foundHover) {
                setHandleScale(foundHover.mesh, foundHover.glow, 1.15);
                renderer.domElement.style.cursor = 'grab';
                hoveredHandle = foundHover;
            } else {
                renderer.domElement.style.cursor = 'default';
                hoveredHandle = null;
            }
            return;
        }
        
        // Dragging logic
        const plane = new THREE.Plane();
        const intersect = new THREE.Vector3();
        
        if (dragTarget === 'azimuth') {
            plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
            if (raycaster.ray.intersectPlane(plane, intersect)) {
                let angle = Math.atan2(intersect.x, intersect.z) * (180 / Math.PI);
                if (angle < 0) angle += 360;
                liveAzimuth = Math.max(0, Math.min(360, angle));
                state.azimuth = Math.round(liveAzimuth);
                elements.azimuthSlider.value = state.azimuth;
                updateSliderValues();
                updatePromptDisplay();
                updateVisuals();
            }
        } else if (dragTarget === 'elevation') {
            // Elevation arc is in the YZ plane at X = ELEV_ARC_X
            const elevPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -ELEV_ARC_X);
            if (raycaster.ray.intersectPlane(elevPlane, intersect)) {
                const relY = intersect.y - CENTER.y;
                const relZ = intersect.z;
                let angle = Math.atan2(relY, relZ) * (180 / Math.PI);
                // vertical_angle: -30 to 90 per fal.ai API
                angle = Math.max(-30, Math.min(90, angle));
                liveElevation = angle;
                state.elevation = Math.round(liveElevation);
                elements.elevationSlider.value = state.elevation;
                updateSliderValues();
                updatePromptDisplay();
                updateVisuals();
            }
        } else if (dragTarget === 'distance') {
            // Map mouse Y to zoom (0-10) per fal.ai API
            // Dragging outward/up = wider shot (lower zoom)
            // Dragging inward/down = closer shot (higher zoom)
            const newDist = 5 - mouse.y * 5;
            liveDistance = Math.max(0, Math.min(10, newDist));
            state.distance = Math.round(liveDistance * 10) / 10; // Round to 1 decimal
            elements.distanceSlider.value = state.distance;
            updateSliderValues();
            updatePromptDisplay();
            updateVisuals();
        }
    }
    
    function onPointerUp() {
        if (isDragging) {
            // Reset handle scale
            const handles = [
                { mesh: azimuthHandle, glow: azGlow },
                { mesh: elevationHandle, glow: elGlow },
                { mesh: distanceHandle, glow: distGlow }
            ];
            handles.forEach(h => setHandleScale(h.mesh, h.glow, 1.0));
        }
        
        isDragging = false;
        dragTarget = null;
        renderer.domElement.style.cursor = 'default';
    }
    
    // Event listeners
    renderer.domElement.addEventListener('mousedown', onPointerDown);
    renderer.domElement.addEventListener('mousemove', onPointerMove);
    renderer.domElement.addEventListener('mouseup', onPointerUp);
    renderer.domElement.addEventListener('mouseleave', onPointerUp);
    
    renderer.domElement.addEventListener('touchstart', (e) => {
        e.preventDefault();
        onPointerDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }, { passive: false });
    
    renderer.domElement.addEventListener('touchmove', (e) => {
        e.preventDefault();
        onPointerMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    }, { passive: false });
    
    renderer.domElement.addEventListener('touchend', onPointerUp);
    
    // Animation loop with subtle animations
    let time = 0;
    function animate() {
        requestAnimationFrame(animate);
        time += 0.01;
        
        // Subtle pulsing on handles
        const pulse = 1 + Math.sin(time * 2) * 0.03;
        camGlow.scale.setScalar(pulse);
        
        // Rotate glow ring
        glowRing.rotation.z += 0.003;
        
        renderer.render(scene, camera);
    }
    animate();
    
    // Resize
    function onResize() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);
    
    // Public API
    threeScene = {
        updatePositions: () => {
            liveAzimuth = state.azimuth;
            liveElevation = state.elevation;
            liveDistance = state.distance;
            updateVisuals();
        },
        syncFromSliders: () => {
            liveAzimuth = state.azimuth;
            liveElevation = state.elevation;
            liveDistance = state.distance;
            updateVisuals();
        },
        updateImage: (url) => {
            if (url) {
                console.log('3D scene: Loading image from:', url.substring(0, 50) + '...');
                
                // For base64 data URLs, load directly via Image element
                const img = new Image();
                // Only set crossOrigin for non-data URLs
                if (!url.startsWith('data:')) {
                    img.crossOrigin = 'anonymous';
                }
                
                img.onload = () => {
                    console.log('3D scene: Image element loaded', img.width, 'x', img.height);
                    const tex = new THREE.Texture(img);
                    tex.needsUpdate = true;
                    tex.colorSpace = THREE.SRGBColorSpace;
                    planeMat.map = tex;
                    planeMat.color.set(0xffffff);
                    planeMat.needsUpdate = true;
                    
                    // Scale based on aspect ratio (like original)
                    const ar = img.width / img.height;
                    const maxSize = 1.5;
                    let scaleX, scaleY;
                    if (ar > 1) {
                        scaleX = maxSize;
                        scaleY = maxSize / ar;
                    } else {
                        scaleY = maxSize;
                        scaleX = maxSize * ar;
                    }
                    imagePlane.scale.set(scaleX, scaleY, 1);
                    imageFrame.scale.set(scaleX, scaleY, 1);
                    
                    console.log('3D scene: Texture applied successfully');
                };
                
                img.onerror = (err) => {
                    console.warn('3D scene: Could not load image', err);
                    planeMat.map = null;
                    planeMat.color.set(0xE93D82);
                    planeMat.needsUpdate = true;
                };
                
                img.src = url;
            } else {
                planeMat.map = null;
                planeMat.color.set(0x3a3a4a);
                planeMat.needsUpdate = true;
                imagePlane.scale.set(1, 1, 1);
                imageFrame.scale.set(1, 1, 1);
            }
        }
    };
}

// ===== Image Upload Handling =====
// ===== Image Validation =====
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

function validateImageFile(file) {
    if (!file) {
        return { valid: false, error: 'No file provided' };
    }
    
    // Check MIME type
    if (!file.type || !ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase())) {
        return { valid: false, error: `Invalid file type: ${file.type || 'unknown'}. Allowed: JPG, PNG, WebP, GIF` };
    }
    
    // Check file extension as backup
    const fileName = file.name.toLowerCase();
    const hasValidExtension = ALLOWED_EXTENSIONS.some(ext => fileName.endsWith(ext));
    if (!hasValidExtension) {
        return { valid: false, error: `Invalid file extension. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` };
    }
    
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        return { valid: false, error: `File too large: ${sizeMB}MB. Maximum: 20MB` };
    }
    
    return { valid: true };
}

function validateImageUrl(url) {
    if (!url || !url.trim()) {
        return { valid: false, error: 'No URL provided' };
    }
    
    url = url.trim();
    
    // Check URL format
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { valid: false, error: 'URL must start with http:// or https://' };
    }
    
    // Check for image extension (optional - some URLs don't have extensions)
    const urlLower = url.toLowerCase();
    const looksLikeImage = ALLOWED_EXTENSIONS.some(ext => urlLower.includes(ext)) || 
                          urlLower.includes('image') || 
                          urlLower.includes('img') ||
                          urlLower.includes('photo');
    
    // We'll allow it even without extension, as many image URLs don't have them
    return { valid: true, warning: !looksLikeImage ? 'URL may not be an image' : null };
}

function handleImageUpload(file) {
    const validation = validateImageFile(file);
    if (!validation.valid) {
        showStatus(validation.error, 'error');
        addLog(`Error: ${validation.error}`, 'error');
        return;
    }
    
    addLog(`Uploading image: ${file.name} (${(file.size / 1024).toFixed(1)} KB, ${file.type})`, 'info');
    
    // Clear any URL when uploading a file
    state.imageUrl = null;
    if (elements.imageUrlInput) {
        elements.imageUrlInput.value = '';
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        state.uploadedImage = file;
        state.uploadedImageBase64 = e.target.result;
        
        elements.previewImage.src = e.target.result;
        elements.previewImage.classList.remove('hidden');
        elements.uploadPlaceholder.classList.add('hidden');
        elements.clearImage.classList.remove('hidden');
        elements.uploadZone.classList.add('has-image');
        
        // Update 3D scene
        if (threeScene) {
            threeScene.updateImage(e.target.result);
        }
        
        addLog(`Image loaded successfully. Base64 size: ${(e.target.result.length / 1024).toFixed(1)} KB`, 'info');
        
        updateGenerateButton();
        hideStatus();
    };
    reader.readAsDataURL(file);
}

function clearImage() {
    state.uploadedImage = null;
    state.uploadedImageBase64 = null;
    state.imageUrl = null;
    
    elements.previewImage.src = '';
    elements.previewImage.classList.add('hidden');
    elements.uploadPlaceholder.classList.remove('hidden');
    elements.clearImage.classList.add('hidden');
    elements.uploadZone.classList.remove('has-image');
    elements.imageUrlInput.value = '';
    
    // Reset upload placeholder content
    elements.uploadPlaceholder.innerHTML = `
        <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>Drop image here or click to upload</p>
    `;
    
    if (threeScene) {
        threeScene.updateImage(null);
    }
    
    updateGenerateButton();
}

function loadImageFromUrl(url) {
    const validation = validateImageUrl(url);
    if (!validation.valid) {
        showStatus(validation.error, 'error');
        addLog(`Error: ${validation.error}`, 'error');
        return;
    }

    url = url.trim();

    if (validation.warning) {
        addLog(`Warning: ${validation.warning}`, 'warn');
    }

    addLog(`Loading image from URL: ${url}`, 'info');
    showStatus('Loading image...', 'info');

    // Clear any previously uploaded file
    state.uploadedImage = null;
    state.uploadedImageBase64 = null;

    // Set the URL
    state.imageUrl = url;

    // Show URL indicator immediately
    elements.uploadPlaceholder.innerHTML = `
        <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <p style="font-size: 11px; word-break: break-all; color: var(--accent);">URL loaded</p>
        <p style="font-size: 10px; word-break: break-all; opacity: 0.6;">${url.length > 40 ? url.substring(0, 40) + '...' : url}</p>
    `;
    elements.clearImage.classList.remove('hidden');
    elements.uploadZone.classList.add('has-image');
    updateGenerateButton();

    // Try to load the image for preview (without crossOrigin first for better compatibility)
    const img = new Image();

    img.onload = () => {
        // Successfully loaded - show preview
        elements.previewImage.src = url;
        elements.previewImage.classList.remove('hidden');
        elements.uploadPlaceholder.classList.add('hidden');

        addLog(`Image preview loaded successfully`, 'info');
        hideStatus();
    };

    img.onerror = () => {
        // Preview failed but URL is still set - show indicator
        addLog(`Could not preview image (CORS/network), but URL is set for generation`, 'warn');
        elements.previewImage.classList.add('hidden');
        elements.uploadPlaceholder.classList.remove('hidden');
        hideStatus();
    };

    img.src = url;

    // Update 3D scene separately (it handles its own CORS)
    if (threeScene) {
        threeScene.updateImage(url);
    }
}

function handleNextSceneImageUpload(file) {
    const validation = validateImageFile(file);
    if (!validation.valid) {
        showNextSceneStatus(validation.error, 'error');
        addNextSceneLog(`Error: ${validation.error}`, 'error');
        return;
    }

    addNextSceneLog(`Uploading image: ${file.name} (${(file.size / 1024).toFixed(1)} KB, ${file.type})`, 'info');

    nextSceneState.imageUrl = null;
    nextSceneState.sourceImageUrl = null;
    if (nextSceneElements.imageUrlInput) {
        nextSceneElements.imageUrlInput.value = '';
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        nextSceneState.uploadedImage = file;
        nextSceneState.uploadedImageBase64 = e.target.result;

        nextSceneElements.previewImage.src = e.target.result;
        nextSceneElements.previewImage.classList.remove('hidden');
        nextSceneElements.uploadPlaceholder.classList.add('hidden');
        nextSceneElements.clearImage.classList.remove('hidden');
        nextSceneElements.uploadZone.classList.add('has-image');

        addNextSceneLog(`Image loaded successfully. Base64 size: ${(e.target.result.length / 1024).toFixed(1)} KB`, 'info');
        updateNextSceneButton();
        hideNextSceneStatus();
    };
    reader.readAsDataURL(file);
}

function clearNextSceneImage() {
    nextSceneState.uploadedImage = null;
    nextSceneState.uploadedImageBase64 = null;
    nextSceneState.imageUrl = null;
    nextSceneState.sourceImageUrl = null;
    nextSceneState.activeRequestId = null;

    nextSceneElements.previewImage.src = '';
    nextSceneElements.previewImage.classList.add('hidden');
    nextSceneElements.uploadPlaceholder.classList.remove('hidden');
    nextSceneElements.clearImage.classList.add('hidden');
    nextSceneElements.uploadZone.classList.remove('has-image');
    nextSceneElements.imageUrlInput.value = '';

    nextSceneElements.uploadPlaceholder.innerHTML = `
        <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>Drop image here or click to upload</p>
    `;

    updateNextSceneButton();
}

function loadNextSceneImageFromUrl(url) {
    const validation = validateImageUrl(url);
    if (!validation.valid) {
        showNextSceneStatus(validation.error, 'error');
        addNextSceneLog(`Error: ${validation.error}`, 'error');
        return;
    }

    url = url.trim();

    if (validation.warning) {
        addNextSceneLog(`Warning: ${validation.warning}`, 'warn');
    }

    addNextSceneLog(`Loading image from URL: ${url}`, 'info');
    showNextSceneStatus('Loading image...', 'info');

    nextSceneState.uploadedImage = null;
    nextSceneState.uploadedImageBase64 = null;
    nextSceneState.imageUrl = url;
    nextSceneState.sourceImageUrl = url;

    nextSceneElements.uploadPlaceholder.innerHTML = `
        <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <p style="font-size: 11px; word-break: break-all; color: var(--accent);">URL loaded</p>
        <p style="font-size: 10px; word-break: break-all; opacity: 0.6;">${url.length > 40 ? url.substring(0, 40) + '...' : url}</p>
    `;
    nextSceneElements.clearImage.classList.remove('hidden');
    nextSceneElements.uploadZone.classList.add('has-image');
    updateNextSceneButton();

    const img = new Image();
    img.onload = () => {
        nextSceneElements.previewImage.src = url;
        nextSceneElements.previewImage.classList.remove('hidden');
        nextSceneElements.uploadPlaceholder.classList.add('hidden');
        addNextSceneLog('Image preview loaded successfully', 'info');
        hideNextSceneStatus();
    };

    img.onerror = () => {
        addNextSceneLog('Could not preview image (CORS/network), but URL is set for generation', 'warn');
        nextSceneElements.previewImage.classList.add('hidden');
        nextSceneElements.uploadPlaceholder.classList.remove('hidden');
        hideNextSceneStatus();
    };

    img.src = url;
}

function handleGaussianSplashImageUpload(file) {
    const validation = validateImageFile(file);
    if (!validation.valid) {
        showGaussianSplashStatus(validation.error, 'error');
        addGaussianSplashLog(`Error: ${validation.error}`, 'error');
        return;
    }

    addGaussianSplashLog(`Uploading image: ${file.name} (${(file.size / 1024).toFixed(1)} KB, ${file.type})`, 'info');

    gaussianSplashState.imageUrl = null;
    gaussianSplashState.sourceImageUrl = null;
    if (gaussianSplashElements.imageUrlInput) {
        gaussianSplashElements.imageUrlInput.value = '';
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        gaussianSplashState.uploadedImage = file;
        gaussianSplashState.uploadedImageBase64 = e.target.result;

        gaussianSplashElements.previewImage.src = e.target.result;
        gaussianSplashElements.previewImage.classList.remove('hidden');
        gaussianSplashElements.uploadPlaceholder.classList.add('hidden');
        gaussianSplashElements.clearImage.classList.remove('hidden');
        gaussianSplashElements.uploadZone.classList.add('has-image');

        addGaussianSplashLog(`Image loaded successfully. Base64 size: ${(e.target.result.length / 1024).toFixed(1)} KB`, 'info');
        updateGaussianSplashButton();
        hideGaussianSplashStatus();
    };
    reader.readAsDataURL(file);
}

function clearGaussianSplashImage() {
    gaussianSplashState.uploadedImage = null;
    gaussianSplashState.uploadedImageBase64 = null;
    gaussianSplashState.imageUrl = null;
    gaussianSplashState.sourceImageUrl = null;
    gaussianSplashState.activeRequestId = null;

    gaussianSplashElements.previewImage.src = '';
    gaussianSplashElements.previewImage.classList.add('hidden');
    gaussianSplashElements.uploadPlaceholder.classList.remove('hidden');
    gaussianSplashElements.clearImage.classList.add('hidden');
    gaussianSplashElements.uploadZone.classList.remove('has-image');
    gaussianSplashElements.imageUrlInput.value = '';

    gaussianSplashElements.uploadPlaceholder.innerHTML = `
        <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>Drop Gaussian splash camera image here or click to upload</p>
    `;

    updateGaussianSplashButton();
}

function loadGaussianSplashImageFromUrl(url) {
    const validation = validateImageUrl(url);
    if (!validation.valid) {
        showGaussianSplashStatus(validation.error, 'error');
        addGaussianSplashLog(`Error: ${validation.error}`, 'error');
        return;
    }

    url = url.trim();

    if (validation.warning) {
        addGaussianSplashLog(`Warning: ${validation.warning}`, 'warn');
    }

    addGaussianSplashLog(`Loading image from URL: ${url}`, 'info');
    showGaussianSplashStatus('Loading image...', 'info');

    gaussianSplashState.uploadedImage = null;
    gaussianSplashState.uploadedImageBase64 = null;
    gaussianSplashState.imageUrl = url;
    gaussianSplashState.sourceImageUrl = url;

    gaussianSplashElements.uploadPlaceholder.innerHTML = `
        <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <p style="font-size: 11px; word-break: break-all; color: var(--accent);">URL loaded</p>
        <p style="font-size: 10px; word-break: break-all; opacity: 0.6;">${url.length > 40 ? url.substring(0, 40) + '...' : url}</p>
    `;
    gaussianSplashElements.clearImage.classList.remove('hidden');
    gaussianSplashElements.uploadZone.classList.add('has-image');
    updateGaussianSplashButton();

    const img = new Image();
    img.onload = () => {
        gaussianSplashElements.previewImage.src = url;
        gaussianSplashElements.previewImage.classList.remove('hidden');
        gaussianSplashElements.uploadPlaceholder.classList.add('hidden');
        addGaussianSplashLog('Image preview loaded successfully', 'info');
        hideGaussianSplashStatus();
    };

    img.onerror = () => {
        addGaussianSplashLog('Could not preview image (CORS/network), but URL is set for generation', 'warn');
        gaussianSplashElements.previewImage.classList.add('hidden');
        gaussianSplashElements.uploadPlaceholder.classList.remove('hidden');
        hideGaussianSplashStatus();
    };

    img.src = url;
}

function applyLightTransferImageUrlToUi(kind, url) {
    const isSource = kind === 'source';
    const uploadPlaceholder = isSource ? lightTransferElements.sourceUploadPlaceholder : lightTransferElements.referenceUploadPlaceholder;
    const clearImage = isSource ? lightTransferElements.sourceClearImage : lightTransferElements.referenceClearImage;
    const uploadZone = isSource ? lightTransferElements.sourceUploadZone : lightTransferElements.referenceUploadZone;
    const previewImage = isSource ? lightTransferElements.sourcePreviewImage : lightTransferElements.referencePreviewImage;

    if (!uploadPlaceholder || !clearImage || !uploadZone || !previewImage) return;

    uploadPlaceholder.innerHTML = `
        <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <p style="font-size: 11px; word-break: break-all; color: var(--accent);">URL loaded</p>
        <p style="font-size: 10px; word-break: break-all; opacity: 0.6;">${url.length > 40 ? url.substring(0, 40) + '...' : url}</p>
    `;

    clearImage.classList.remove('hidden');
    uploadZone.classList.add('has-image');

    const img = new Image();
    img.onload = () => {
        previewImage.src = url;
        previewImage.classList.remove('hidden');
        uploadPlaceholder.classList.add('hidden');
        addLightTransferLog(`${isSource ? 'Source' : 'Reference'} image preview loaded successfully`, 'info');
        hideLightTransferStatus();
    };

    img.onerror = () => {
        addLightTransferLog(`Could not preview ${isSource ? 'source' : 'reference'} image (CORS/network), but URL is set for generation`, 'warn');
        previewImage.classList.add('hidden');
        uploadPlaceholder.classList.remove('hidden');
        hideLightTransferStatus();
    };

    img.src = url;
}

function handleLightTransferImageUpload(kind, file) {
    const isSource = kind === 'source';
    const validation = validateImageFile(file);
    if (!validation.valid) {
        showLightTransferStatus(validation.error, 'error');
        addLightTransferLog(`Error: ${validation.error}`, 'error');
        return;
    }

    addLightTransferLog(`Uploading ${isSource ? 'source' : 'reference'} image: ${file.name} (${(file.size / 1024).toFixed(1)} KB, ${file.type})`, 'info');

    if (isSource) {
        lightTransferState.sourceImageUrl = null;
        lightTransferState.sourceResolvedImageUrl = null;
        if (lightTransferElements.sourceImageUrlInput) {
            lightTransferElements.sourceImageUrlInput.value = '';
        }
    } else {
        lightTransferState.referenceImageUrl = null;
        lightTransferState.referenceResolvedImageUrl = null;
        if (lightTransferElements.referenceImageUrlInput) {
            lightTransferElements.referenceImageUrlInput.value = '';
        }
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        if (isSource) {
            lightTransferState.sourceUploadedImage = file;
            lightTransferState.sourceUploadedImageBase64 = e.target.result;
            lightTransferElements.sourcePreviewImage.src = e.target.result;
            lightTransferElements.sourcePreviewImage.classList.remove('hidden');
            lightTransferElements.sourceUploadPlaceholder.classList.add('hidden');
            lightTransferElements.sourceClearImage.classList.remove('hidden');
            lightTransferElements.sourceUploadZone.classList.add('has-image');
        } else {
            lightTransferState.referenceUploadedImage = file;
            lightTransferState.referenceUploadedImageBase64 = e.target.result;
            lightTransferElements.referencePreviewImage.src = e.target.result;
            lightTransferElements.referencePreviewImage.classList.remove('hidden');
            lightTransferElements.referenceUploadPlaceholder.classList.add('hidden');
            lightTransferElements.referenceClearImage.classList.remove('hidden');
            lightTransferElements.referenceUploadZone.classList.add('has-image');
        }

        addLightTransferLog(`${isSource ? 'Source' : 'Reference'} image loaded successfully. Base64 size: ${(e.target.result.length / 1024).toFixed(1)} KB`, 'info');
        updateLightTransferButton();
        hideLightTransferStatus();
    };
    reader.readAsDataURL(file);
}

function clearLightTransferImage(kind) {
    const isSource = kind === 'source';
    const previewImage = isSource ? lightTransferElements.sourcePreviewImage : lightTransferElements.referencePreviewImage;
    const uploadPlaceholder = isSource ? lightTransferElements.sourceUploadPlaceholder : lightTransferElements.referenceUploadPlaceholder;
    const clearImage = isSource ? lightTransferElements.sourceClearImage : lightTransferElements.referenceClearImage;
    const uploadZone = isSource ? lightTransferElements.sourceUploadZone : lightTransferElements.referenceUploadZone;
    const imageUrlInput = isSource ? lightTransferElements.sourceImageUrlInput : lightTransferElements.referenceImageUrlInput;

    if (isSource) {
        lightTransferState.sourceUploadedImage = null;
        lightTransferState.sourceUploadedImageBase64 = null;
        lightTransferState.sourceImageUrl = null;
        lightTransferState.sourceResolvedImageUrl = null;
    } else {
        lightTransferState.referenceUploadedImage = null;
        lightTransferState.referenceUploadedImageBase64 = null;
        lightTransferState.referenceImageUrl = null;
        lightTransferState.referenceResolvedImageUrl = null;
    }

    if (previewImage) {
        previewImage.src = '';
        previewImage.classList.add('hidden');
    }
    if (uploadPlaceholder) {
        uploadPlaceholder.classList.remove('hidden');
        uploadPlaceholder.innerHTML = `
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <p>${isSource ? 'Drop source image here or click to upload' : 'Drop lighting reference here or click to upload'}</p>
        `;
    }
    if (clearImage) clearImage.classList.add('hidden');
    if (uploadZone) uploadZone.classList.remove('has-image');
    if (imageUrlInput) imageUrlInput.value = '';

    updateLightTransferButton();
}

function loadLightTransferImageFromUrl(kind, url) {
    const isSource = kind === 'source';
    const validation = validateImageUrl(url);
    if (!validation.valid) {
        showLightTransferStatus(validation.error, 'error');
        addLightTransferLog(`Error: ${validation.error}`, 'error');
        return;
    }

    url = url.trim();

    if (validation.warning) {
        addLightTransferLog(`Warning: ${validation.warning}`, 'warn');
    }

    addLightTransferLog(`Loading ${isSource ? 'source' : 'reference'} image from URL: ${url}`, 'info');
    showLightTransferStatus('Loading image...', 'info');

    if (isSource) {
        lightTransferState.sourceUploadedImage = null;
        lightTransferState.sourceUploadedImageBase64 = null;
        lightTransferState.sourceImageUrl = url;
        lightTransferState.sourceResolvedImageUrl = url;
    } else {
        lightTransferState.referenceUploadedImage = null;
        lightTransferState.referenceUploadedImageBase64 = null;
        lightTransferState.referenceImageUrl = url;
        lightTransferState.referenceResolvedImageUrl = url;
    }

    applyLightTransferImageUrlToUi(kind, url);
    updateLightTransferButton();
}

// ===== Backend API Helpers =====
async function apiRequest(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const payload = isJson ? await response.json() : await response.text();

    if (!response.ok) {
        const message = isJson
            ? (payload?.error || payload?.message || JSON.stringify(payload))
            : String(payload || `Request failed (${response.status})`);
        const err = new Error(message);
        err.status = response.status;
        err.body = payload;
        throw err;
    }

    return payload;
}

async function uploadImageToBackend(file) {
    const formData = new FormData();
    formData.append('image', file);
    const result = await apiRequest('/api/upload', {
        method: 'POST',
        body: formData
    });

    if (!result?.url) {
        throw new Error('Upload succeeded but no URL was returned.');
    }

    return result.url;
}

// ===== API Call =====
async function generateImage() {
    if (!state.uploadedImage && !state.imageUrl) {
        showStatus('Please upload an image or provide a URL', 'error');
        addLog('Error: No image provided', 'error');
        return;
    }
    
    state.isGenerating = true;
    updateGenerateButton();
    
    // Add loading UI states
    elements.generateBtn.classList.add('generating');
    elements.generateBtn.querySelector('.btn-text').textContent = 'Generating...';
    elements.generateBtn.querySelector('.btn-loader').classList.remove('hidden');
    elements.outputContainer.classList.add('loading');
    elements.outputPlaceholder.classList.add('loading');
    
    // Dynamic loading messages
    const loadingMessages = [
        'Processing image...',
        'Analyzing camera angle...',
        'Rendering new view...',
        'Almost there...'
    ];
    let messageIndex = 0;
    const loadingInterval = setInterval(() => {
        if (state.isGenerating) {
            showStatus(loadingMessages[messageIndex % loadingMessages.length], 'info');
            messageIndex++;
        } else {
            clearInterval(loadingInterval);
        }
    }, 3000);
    
    hideStatus();
    
    addLog('Calling backend generation API...', 'info');
    addLog(`Camera: horizontal_angle=${state.azimuth}°, vertical_angle=${state.elevation}°, zoom=${state.distance}`, 'info');
    
    try {
        let imageUrl = state.imageUrl;

        if (!imageUrl) {
            showStatus('Uploading image...', 'info');
            addLog('Uploading image via backend...', 'request');
            imageUrl = await uploadImageToBackend(state.uploadedImage);
            addLog(`Image uploaded: ${imageUrl}`, 'response');
        } else {
            addLog(`Using provided URL: ${imageUrl}`, 'info');
        }
        
        showStatus('Generating... This may take a moment.', 'info');

        const result = await apiRequest('/api/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageUrl,
                horizontal_angle: state.azimuth,
                vertical_angle: state.elevation,
                zoom: state.distance
            })
        });

        const outputImageUrl = result?.imageUrl;

        if (!outputImageUrl) {
            addLog('Error: Could not extract image URL from response', 'error');
            throw new Error('No image in response. Check logs for details.');
        }

        elements.outputImage.src = outputImageUrl;
        elements.outputImage.classList.remove('hidden');
        elements.outputPlaceholder.classList.add('hidden');
        elements.downloadBtn.classList.remove('hidden');

        // Trigger success animation
        elements.outputContainer.classList.add('success');
        setTimeout(() => {
            elements.outputContainer.classList.remove('success');
        }, 600);

        addLog(`Success! Image URL: ${outputImageUrl.substring(0, 80)}...`, 'info');
        showStatus('Image generated successfully!', 'success');

        
    } catch (error) {
        console.error('Generation error:', error);
        const errorMsg = formatError(error?.body || error);
        addLog(`Error: ${errorMsg}`, 'error');
        if (error?.body && typeof error.body === 'object') {
            addLog(`Error body: ${JSON.stringify(error.body, null, 2)}`, 'error');
        }
        showStatus(`Error: ${errorMsg}`, 'error');
    } finally {
        state.isGenerating = false;
        updateGenerateButton();
        
        // Remove loading UI states
        elements.generateBtn.classList.remove('generating');
        elements.generateBtn.querySelector('.btn-text').textContent = 'Generate';
        elements.generateBtn.querySelector('.btn-loader').classList.add('hidden');
        elements.outputContainer.classList.remove('loading');
        elements.outputPlaceholder.classList.remove('loading');
    }
}

// ===== Download =====
async function downloadImage() {
    const imageUrl = elements.outputImage.src;
    if (!imageUrl) return;

    try {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `qwen-multiangle-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    } catch (error) {
        // Fallback: open in new tab
        window.open(imageUrl, '_blank');
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollNextSceneStatus(requestId, runToken, options = {}) {
    const pollIntervalMs = options.pollIntervalMs || 2000;
    const timeoutMs = options.timeoutMs || 180000;
    const startedAt = Date.now();
    let lastUiStatus = null;

    while (true) {
        if (nextSceneState.runToken !== runToken) {
            throw new Error('A newer next-scene run started. Ignoring stale response.');
        }

        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Next scene generation timed out while waiting for provider completion. Please try again.');
        }

        const statusResult = await apiRequest(`/api/generate-next-scene/${encodeURIComponent(requestId)}`);

        if (nextSceneState.runToken !== runToken) {
            throw new Error('A newer next-scene run started. Ignoring stale response.');
        }

        if (statusResult?.status === 'queued') {
            if (lastUiStatus !== 'queued') {
                showNextSceneStatus('Next scene queued... waiting for provider.', 'info');
                addNextSceneLog('Queue status: queued', 'info');
                lastUiStatus = 'queued';
            }
            await delay(pollIntervalMs);
            continue;
        }

        if (statusResult?.status === 'in_progress') {
            if (lastUiStatus !== 'in_progress') {
                showNextSceneStatus('Generating next scene... in progress.', 'info');
                addNextSceneLog('Queue status: in progress', 'info');
                lastUiStatus = 'in_progress';
            }
            await delay(pollIntervalMs);
            continue;
        }

        if (statusResult?.status === 'completed') {
            const outputImageUrl = statusResult?.imageUrl;
            if (!outputImageUrl) {
                addNextSceneLog('Error: Completed status returned without an image URL', 'error');
                throw new Error('No image in completed response. Check logs for details.');
            }
            return outputImageUrl;
        }

        if (statusResult?.status === 'failed') {
            const providerError = new Error(
                statusResult?.error || formatError(statusResult?.detail || statusResult)
            );
            providerError.body = statusResult;
            throw providerError;
        }

        throw new Error(`Unexpected status from next-scene polling: ${statusResult?.status || 'unknown'}`);
    }
}

async function generateNextScene() {
    if (!nextSceneState.uploadedImage && !nextSceneState.imageUrl) {
        showNextSceneStatus('Please upload an image or provide a URL', 'error');
        addNextSceneLog('Error: No image provided', 'error');
        return;
    }

    const prompt = nextSceneElements.prompt?.value?.trim() || '';
    if (!prompt) {
        showNextSceneStatus('Please describe the next scene', 'error');
        addNextSceneLog('Error: No prompt provided', 'error');
        return;
    }

    nextSceneState.isGenerating = true;
    nextSceneState.runToken += 1;
    const runToken = nextSceneState.runToken;
    nextSceneState.activeRequestId = null;
    updateNextSceneButton();

    nextSceneElements.generateBtn.classList.add('generating');
    nextSceneElements.generateBtn.querySelector('.btn-text').textContent = 'Generating...';
    nextSceneElements.generateBtn.querySelector('.btn-loader').classList.remove('hidden');
    nextSceneElements.outputContainer.classList.add('loading');
    nextSceneElements.outputPlaceholder.classList.add('loading');

    hideNextSceneStatus();
    addNextSceneLog('Calling backend next-scene API...', 'info');
    addNextSceneLog(`Prompt preview: Next Scene: ${prompt}`, 'info');
    addNextSceneLog(`LoRA scale: ${nextSceneElements.loraScale?.value || '0.75'}`, 'info');

    try {
        let imageUrl = nextSceneState.imageUrl;

        if (!imageUrl) {
            showNextSceneStatus('Uploading image...', 'info');
            addNextSceneLog('Uploading image via backend...', 'request');
            imageUrl = await uploadImageToBackend(nextSceneState.uploadedImage);
            nextSceneState.sourceImageUrl = imageUrl;
            addNextSceneLog(`Image uploaded: ${imageUrl}`, 'response');
        } else {
            nextSceneState.sourceImageUrl = imageUrl;
            addNextSceneLog(`Using provided URL: ${imageUrl}`, 'info');
        }

        showNextSceneStatus('Submitting next-scene job...', 'info');

        const submitResult = await apiRequest('/api/generate-next-scene', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageUrl,
                prompt,
                loraScale: nextSceneElements.loraScale?.value || '0.75'
            })
        });

        const requestId = submitResult?.requestId;
        if (!requestId) {
            addNextSceneLog('Error: No request ID returned from submit endpoint', 'error');
            throw new Error('No request ID was returned by submit endpoint.');
        }

        nextSceneState.activeRequestId = requestId;
        addNextSceneLog(`Submitted next-scene job. requestId=${requestId}`, 'request');
        showNextSceneStatus('Next scene queued... waiting for provider.', 'info');

        const outputImageUrl = await pollNextSceneStatus(requestId, runToken, {
            pollIntervalMs: 2000,
            timeoutMs: 180000
        });

        if (nextSceneState.runToken !== runToken) {
            return;
        }

        nextSceneElements.outputImage.src = outputImageUrl;
        nextSceneElements.outputImage.classList.remove('hidden');
        nextSceneElements.outputPlaceholder.classList.add('hidden');
        nextSceneElements.downloadBtn.classList.remove('hidden');
        nextSceneElements.outputContainer.classList.add('success');
        setTimeout(() => {
            nextSceneElements.outputContainer.classList.remove('success');
        }, 600);

        addNextSceneLog(`Success! Image URL: ${outputImageUrl.substring(0, 80)}...`, 'info');
        showNextSceneStatus('Next scene generated successfully!', 'success');
    } catch (error) {
        if (nextSceneState.runToken !== runToken) {
            return;
        }

        console.error('Next-scene generation error:', error);
        const failedPayload = error?.body && error.body.status === 'failed' ? error.body : null;
        const errorMsg = failedPayload
            ? (failedPayload.error || formatError(failedPayload.detail || failedPayload))
            : formatError(error?.body || error);
        addNextSceneLog(`Error: ${errorMsg}`, 'error');

        if (failedPayload?.detail) {
            addNextSceneLog(`Provider detail: ${JSON.stringify(failedPayload.detail, null, 2)}`, 'error');
        } else if (error?.body && typeof error.body === 'object') {
            addNextSceneLog(`Error body: ${JSON.stringify(error.body, null, 2)}`, 'error');
        }

        showNextSceneStatus(`Error: ${errorMsg}`, 'error');
    } finally {
        if (nextSceneState.runToken === runToken) {
            nextSceneState.isGenerating = false;
            nextSceneState.activeRequestId = null;
            updateNextSceneButton();
            nextSceneElements.generateBtn.classList.remove('generating');
            nextSceneElements.generateBtn.querySelector('.btn-text').textContent = 'Generate Next Scene';
            nextSceneElements.generateBtn.querySelector('.btn-loader').classList.add('hidden');
            nextSceneElements.outputContainer.classList.remove('loading');
            nextSceneElements.outputPlaceholder.classList.remove('loading');
        }
    }
}

async function downloadNextSceneImage() {
    const imageUrl = nextSceneElements.outputImage.src;
    if (!imageUrl) return;

    try {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `mixio-next-scene-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    } catch (error) {
        window.open(imageUrl, '_blank');
    }
}

async function pollLightTransferStatus(requestId, runToken, options = {}) {
    const pollIntervalMs = options.pollIntervalMs || 2000;
    const timeoutMs = options.timeoutMs || 180000;
    const startedAt = Date.now();
    let lastUiStatus = null;

    while (true) {
        if (lightTransferState.runToken !== runToken) {
            throw new Error('A newer light-transfer run started. Ignoring stale response.');
        }

        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Light transfer generation timed out while waiting for provider completion. Please try again.');
        }

        const statusResult = await apiRequest(`/api/generate-light-transfer/${encodeURIComponent(requestId)}`);

        if (lightTransferState.runToken !== runToken) {
            throw new Error('A newer light-transfer run started. Ignoring stale response.');
        }

        if (statusResult?.status === 'queued') {
            if (lastUiStatus !== 'queued') {
                showLightTransferStatus('Light transfer queued... waiting for provider.', 'info');
                addLightTransferLog('Queue status: queued', 'info');
                lastUiStatus = 'queued';
            }
            await delay(pollIntervalMs);
            continue;
        }

        if (statusResult?.status === 'in_progress') {
            if (lastUiStatus !== 'in_progress') {
                showLightTransferStatus('Generating light transfer... in progress.', 'info');
                addLightTransferLog('Queue status: in progress', 'info');
                lastUiStatus = 'in_progress';
            }
            await delay(pollIntervalMs);
            continue;
        }

        if (statusResult?.status === 'completed') {
            const outputImageUrl = statusResult?.imageUrl;
            if (!outputImageUrl) {
                addLightTransferLog('Error: Completed status returned without an image URL', 'error');
                throw new Error('No image in completed response. Check logs for details.');
            }
            return outputImageUrl;
        }

        if (statusResult?.status === 'failed') {
            const providerError = new Error(
                statusResult?.error || formatError(statusResult?.detail || statusResult)
            );
            providerError.body = statusResult;
            throw providerError;
        }

        throw new Error(`Unexpected status from light-transfer polling: ${statusResult?.status || 'unknown'}`);
    }
}

async function pollGaussianSplashStatus(requestId, runToken, options = {}) {
    const pollIntervalMs = options.pollIntervalMs || 2000;
    const timeoutMs = options.timeoutMs || 180000;
    const startedAt = Date.now();
    let lastUiStatus = null;

    while (true) {
        if (gaussianSplashState.runToken !== runToken) {
            throw new Error('A newer gaussian-splash run started. Ignoring stale response.');
        }

        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Gaussian Splash generation timed out while waiting for provider completion. Please try again.');
        }

        const statusResult = await apiRequest(`/api/generate-gaussian-splash/${encodeURIComponent(requestId)}`);

        if (gaussianSplashState.runToken !== runToken) {
            throw new Error('A newer gaussian-splash run started. Ignoring stale response.');
        }

        if (statusResult?.status === 'queued') {
            if (lastUiStatus !== 'queued') {
                showGaussianSplashStatus('Gaussian Splash queued... waiting for provider.', 'info');
                addGaussianSplashLog('Queue status: queued', 'info');
                lastUiStatus = 'queued';
            }
            await delay(pollIntervalMs);
            continue;
        }

        if (statusResult?.status === 'in_progress') {
            if (lastUiStatus !== 'in_progress') {
                showGaussianSplashStatus('Generating Gaussian Splash... in progress.', 'info');
                addGaussianSplashLog('Queue status: in progress', 'info');
                lastUiStatus = 'in_progress';
            }
            await delay(pollIntervalMs);
            continue;
        }

        if (statusResult?.status === 'completed') {
            const outputImageUrl = statusResult?.imageUrl;
            if (!outputImageUrl) {
                addGaussianSplashLog('Error: Completed status returned without an image URL', 'error');
                throw new Error('No image in completed response. Check logs for details.');
            }
            return outputImageUrl;
        }

        if (statusResult?.status === 'failed') {
            const providerError = new Error(
                statusResult?.error || formatError(statusResult?.detail || statusResult)
            );
            providerError.body = statusResult;
            throw providerError;
        }

        throw new Error(`Unexpected status from gaussian-splash polling: ${statusResult?.status || 'unknown'}`);
    }
}

async function generateLightTransfer() {
    const hasSource = !!(lightTransferState.sourceUploadedImage || lightTransferState.sourceImageUrl);
    const hasReference = !!(lightTransferState.referenceUploadedImage || lightTransferState.referenceImageUrl);
    if (!hasSource || !hasReference) {
        showLightTransferStatus('Please provide both source and reference images', 'error');
        addLightTransferLog('Error: Missing source or reference image', 'error');
        return;
    }

    lightTransferState.isGenerating = true;
    lightTransferState.runToken += 1;
    const runToken = lightTransferState.runToken;
    lightTransferState.activeRequestId = null;
    updateLightTransferButton();

    lightTransferElements.generateBtn.classList.add('generating');
    lightTransferElements.generateBtn.querySelector('.btn-text').textContent = 'Generating...';
    lightTransferElements.generateBtn.querySelector('.btn-loader').classList.remove('hidden');
    lightTransferElements.outputContainer.classList.add('loading');
    lightTransferElements.outputPlaceholder.classList.add('loading');

    hideLightTransferStatus();
    addLightTransferLog('Calling backend light-transfer API...', 'info');
    addLightTransferLog(`LoRA scale: ${lightTransferElements.loraScale?.value || '0.75'}`, 'info');

    try {
        let sourceImageUrl = lightTransferState.sourceImageUrl;
        let referenceImageUrl = lightTransferState.referenceImageUrl;

        if (!sourceImageUrl) {
            showLightTransferStatus('Uploading source image...', 'info');
            addLightTransferLog('Uploading source image via backend...', 'request');
            sourceImageUrl = await uploadImageToBackend(lightTransferState.sourceUploadedImage);
            lightTransferState.sourceResolvedImageUrl = sourceImageUrl;
            addLightTransferLog(`Source image uploaded: ${sourceImageUrl}`, 'response');
        } else {
            lightTransferState.sourceResolvedImageUrl = sourceImageUrl;
            addLightTransferLog(`Using source URL: ${sourceImageUrl}`, 'info');
        }

        if (!referenceImageUrl) {
            showLightTransferStatus('Uploading reference image...', 'info');
            addLightTransferLog('Uploading reference image via backend...', 'request');
            referenceImageUrl = await uploadImageToBackend(lightTransferState.referenceUploadedImage);
            lightTransferState.referenceResolvedImageUrl = referenceImageUrl;
            addLightTransferLog(`Reference image uploaded: ${referenceImageUrl}`, 'response');
        } else {
            lightTransferState.referenceResolvedImageUrl = referenceImageUrl;
            addLightTransferLog(`Using reference URL: ${referenceImageUrl}`, 'info');
        }

        showLightTransferStatus('Submitting light-transfer job...', 'info');

        const submitResult = await apiRequest('/api/generate-light-transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceImageUrl,
                referenceImageUrl,
                loraScale: lightTransferElements.loraScale?.value || '0.75'
            })
        });

        const requestId = submitResult?.requestId;
        if (!requestId) {
            addLightTransferLog('Error: No request ID returned from submit endpoint', 'error');
            throw new Error('No request ID was returned by submit endpoint.');
        }

        lightTransferState.activeRequestId = requestId;
        addLightTransferLog(`Submitted light-transfer job. requestId=${requestId}`, 'request');
        if (Array.isArray(submitResult?.inputOrder)) {
            addLightTransferLog(`Input order confirmed by backend: ${submitResult.inputOrder.join(' -> ')}`, 'info');
        }
        if (submitResult?.sourceMarker || submitResult?.referenceMarker) {
            addLightTransferLog(
                `Input markers: source=${submitResult?.sourceMarker || 'n/a'}, reference=${submitResult?.referenceMarker || 'n/a'}`,
                'info'
            );
        }
        showLightTransferStatus('Light transfer queued... waiting for provider.', 'info');

        const outputImageUrl = await pollLightTransferStatus(requestId, runToken, {
            pollIntervalMs: 2000,
            timeoutMs: 180000
        });

        if (lightTransferState.runToken !== runToken) {
            return;
        }

        lightTransferElements.outputImage.src = outputImageUrl;
        lightTransferElements.outputImage.classList.remove('hidden');
        lightTransferElements.outputPlaceholder.classList.add('hidden');
        lightTransferElements.downloadBtn.classList.remove('hidden');
        lightTransferElements.outputContainer.classList.add('success');
        setTimeout(() => {
            lightTransferElements.outputContainer.classList.remove('success');
        }, 600);

        addLightTransferLog(`Success! Image URL: ${outputImageUrl.substring(0, 80)}...`, 'info');
        showLightTransferStatus('Light transfer generated successfully!', 'success');
    } catch (error) {
        if (lightTransferState.runToken !== runToken) {
            return;
        }

        console.error('Light-transfer generation error:', error);
        const failedPayload = error?.body && error.body.status === 'failed' ? error.body : null;
        const errorMsg = failedPayload
            ? (failedPayload.error || formatError(failedPayload.detail || failedPayload))
            : formatError(error?.body || error);
        addLightTransferLog(`Error: ${errorMsg}`, 'error');

        if (failedPayload?.detail) {
            addLightTransferLog(`Provider detail: ${JSON.stringify(failedPayload.detail, null, 2)}`, 'error');
        } else if (error?.body && typeof error.body === 'object') {
            addLightTransferLog(`Error body: ${JSON.stringify(error.body, null, 2)}`, 'error');
        }

        showLightTransferStatus(`Error: ${errorMsg}`, 'error');
    } finally {
        if (lightTransferState.runToken === runToken) {
            lightTransferState.isGenerating = false;
            lightTransferState.activeRequestId = null;
            updateLightTransferButton();
            lightTransferElements.generateBtn.classList.remove('generating');
            lightTransferElements.generateBtn.querySelector('.btn-text').textContent = 'Generate Light Transfer';
            lightTransferElements.generateBtn.querySelector('.btn-loader').classList.add('hidden');
            lightTransferElements.outputContainer.classList.remove('loading');
            lightTransferElements.outputPlaceholder.classList.remove('loading');
        }
    }
}

async function downloadLightTransferImage() {
    const imageUrl = lightTransferElements.outputImage?.src;
    if (!imageUrl) return;

    try {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `mixio-light-transfer-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    } catch (error) {
        window.open(imageUrl, '_blank');
    }
}

async function generateGaussianSplash() {
    if (!gaussianSplashState.uploadedImage && !gaussianSplashState.imageUrl) {
        showGaussianSplashStatus('Please upload an image or provide a URL', 'error');
        addGaussianSplashLog('Error: No image provided', 'error');
        return;
    }

    gaussianSplashState.isGenerating = true;
    gaussianSplashState.runToken += 1;
    const runToken = gaussianSplashState.runToken;
    gaussianSplashState.activeRequestId = null;
    updateGaussianSplashButton();

    gaussianSplashElements.generateBtn.classList.add('generating');
    gaussianSplashElements.generateBtn.querySelector('.btn-text').textContent = 'Generating...';
    gaussianSplashElements.generateBtn.querySelector('.btn-loader').classList.remove('hidden');
    gaussianSplashElements.outputContainer.classList.add('loading');
    gaussianSplashElements.outputPlaceholder.classList.add('loading');

    hideGaussianSplashStatus();
    addGaussianSplashLog('Calling backend gaussian-splash API...', 'info');
    addGaussianSplashLog(`LoRA scale: ${gaussianSplashElements.loraScale?.value || '0.75'}`, 'info');

    try {
        let imageUrl = gaussianSplashState.imageUrl;

        if (!imageUrl) {
            showGaussianSplashStatus('Uploading image...', 'info');
            addGaussianSplashLog('Uploading image via backend...', 'request');
            imageUrl = await uploadImageToBackend(gaussianSplashState.uploadedImage);
            gaussianSplashState.sourceImageUrl = imageUrl;
            addGaussianSplashLog(`Image uploaded: ${imageUrl}`, 'response');
        } else {
            gaussianSplashState.sourceImageUrl = imageUrl;
            addGaussianSplashLog(`Using provided URL: ${imageUrl}`, 'info');
        }

        showGaussianSplashStatus('Submitting gaussian-splash job...', 'info');

        const submitResult = await apiRequest('/api/generate-gaussian-splash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageUrl,
                loraScale: gaussianSplashElements.loraScale?.value || '0.75'
            })
        });

        const requestId = submitResult?.requestId;
        if (!requestId) {
            addGaussianSplashLog('Error: No request ID returned from submit endpoint', 'error');
            throw new Error('No request ID was returned by submit endpoint.');
        }

        gaussianSplashState.activeRequestId = requestId;
        addGaussianSplashLog(`Submitted gaussian-splash job. requestId=${requestId}`, 'request');
        showGaussianSplashStatus('Gaussian Splash queued... waiting for provider.', 'info');

        const outputImageUrl = await pollGaussianSplashStatus(requestId, runToken, {
            pollIntervalMs: 2000,
            timeoutMs: 180000
        });

        if (gaussianSplashState.runToken !== runToken) {
            return;
        }

        gaussianSplashElements.outputImage.src = outputImageUrl;
        gaussianSplashElements.outputImage.classList.remove('hidden');
        gaussianSplashElements.outputPlaceholder.classList.add('hidden');
        gaussianSplashElements.downloadBtn.classList.remove('hidden');
        gaussianSplashElements.outputContainer.classList.add('success');
        setTimeout(() => {
            gaussianSplashElements.outputContainer.classList.remove('success');
        }, 600);

        addGaussianSplashLog(`Success! Image URL: ${outputImageUrl.substring(0, 80)}...`, 'info');
        showGaussianSplashStatus('Gaussian Splash generated successfully!', 'success');
    } catch (error) {
        if (gaussianSplashState.runToken !== runToken) {
            return;
        }

        console.error('Gaussian-splash generation error:', error);
        const failedPayload = error?.body && error.body.status === 'failed' ? error.body : null;
        const errorMsg = failedPayload
            ? (failedPayload.error || formatError(failedPayload.detail || failedPayload))
            : formatError(error?.body || error);
        addGaussianSplashLog(`Error: ${errorMsg}`, 'error');

        if (failedPayload?.detail) {
            addGaussianSplashLog(`Provider detail: ${JSON.stringify(failedPayload.detail, null, 2)}`, 'error');
        } else if (error?.body && typeof error.body === 'object') {
            addGaussianSplashLog(`Error body: ${JSON.stringify(error.body, null, 2)}`, 'error');
        }

        showGaussianSplashStatus(`Error: ${errorMsg}`, 'error');
    } finally {
        if (gaussianSplashState.runToken === runToken) {
            gaussianSplashState.isGenerating = false;
            gaussianSplashState.activeRequestId = null;
            updateGaussianSplashButton();
            gaussianSplashElements.generateBtn.classList.remove('generating');
            gaussianSplashElements.generateBtn.querySelector('.btn-text').textContent = 'Generate Gaussian Splash';
            gaussianSplashElements.generateBtn.querySelector('.btn-loader').classList.add('hidden');
            gaussianSplashElements.outputContainer.classList.remove('loading');
            gaussianSplashElements.outputPlaceholder.classList.remove('loading');
        }
    }
}

async function downloadGaussianSplashImage() {
    const imageUrl = gaussianSplashElements.outputImage?.src;
    if (!imageUrl) return;

    try {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `mixio-gaussian-splash-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    } catch (error) {
        window.open(imageUrl, '_blank');
    }
}

function setupLightTransferEventListeners() {
    lightTransferElements.sourceImageInput?.addEventListener('change', (e) => {
        if (e.target.files?.[0]) {
            handleLightTransferImageUpload('source', e.target.files[0]);
        }
    });
    lightTransferElements.sourceUploadZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        lightTransferElements.sourceUploadZone.classList.add('drag-over');
    });
    lightTransferElements.sourceUploadZone?.addEventListener('dragleave', () => {
        lightTransferElements.sourceUploadZone.classList.remove('drag-over');
    });
    lightTransferElements.sourceUploadZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        lightTransferElements.sourceUploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files?.[0]) {
            handleLightTransferImageUpload('source', e.dataTransfer.files[0]);
        }
    });
    lightTransferElements.sourceClearImage?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearLightTransferImage('source');
    });
    lightTransferElements.sourceLoadUrlBtn?.addEventListener('click', () => {
        loadLightTransferImageFromUrl('source', lightTransferElements.sourceImageUrlInput.value);
    });
    lightTransferElements.sourceImageUrlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadLightTransferImageFromUrl('source', lightTransferElements.sourceImageUrlInput.value);
        }
    });

    lightTransferElements.referenceImageInput?.addEventListener('change', (e) => {
        if (e.target.files?.[0]) {
            handleLightTransferImageUpload('reference', e.target.files[0]);
        }
    });
    lightTransferElements.referenceUploadZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        lightTransferElements.referenceUploadZone.classList.add('drag-over');
    });
    lightTransferElements.referenceUploadZone?.addEventListener('dragleave', () => {
        lightTransferElements.referenceUploadZone.classList.remove('drag-over');
    });
    lightTransferElements.referenceUploadZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        lightTransferElements.referenceUploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files?.[0]) {
            handleLightTransferImageUpload('reference', e.dataTransfer.files[0]);
        }
    });
    lightTransferElements.referenceClearImage?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearLightTransferImage('reference');
    });
    lightTransferElements.referenceLoadUrlBtn?.addEventListener('click', () => {
        loadLightTransferImageFromUrl('reference', lightTransferElements.referenceImageUrlInput.value);
    });
    lightTransferElements.referenceImageUrlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadLightTransferImageFromUrl('reference', lightTransferElements.referenceImageUrlInput.value);
        }
    });

    lightTransferElements.loraScale?.addEventListener('change', updateLightTransferButton);
    lightTransferElements.generateBtn?.addEventListener('click', generateLightTransfer);
    lightTransferElements.downloadBtn?.addEventListener('click', downloadLightTransferImage);
    lightTransferElements.clearLogsBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearLightTransferLogs();
    });
}

function setupGaussianSplashEventListeners() {
    gaussianSplashElements.imageInput?.addEventListener('change', (e) => {
        if (e.target.files?.[0]) {
            handleGaussianSplashImageUpload(e.target.files[0]);
        }
    });

    gaussianSplashElements.uploadZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        gaussianSplashElements.uploadZone.classList.add('drag-over');
    });

    gaussianSplashElements.uploadZone?.addEventListener('dragleave', () => {
        gaussianSplashElements.uploadZone.classList.remove('drag-over');
    });

    gaussianSplashElements.uploadZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        gaussianSplashElements.uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files?.[0]) {
            handleGaussianSplashImageUpload(e.dataTransfer.files[0]);
        }
    });

    gaussianSplashElements.clearImage?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearGaussianSplashImage();
    });

    gaussianSplashElements.loadUrlBtn?.addEventListener('click', () => {
        loadGaussianSplashImageFromUrl(gaussianSplashElements.imageUrlInput.value);
    });

    gaussianSplashElements.imageUrlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadGaussianSplashImageFromUrl(gaussianSplashElements.imageUrlInput.value);
        }
    });

    gaussianSplashElements.loraScale?.addEventListener('change', updateGaussianSplashButton);
    gaussianSplashElements.generateBtn?.addEventListener('click', generateGaussianSplash);
    gaussianSplashElements.downloadBtn?.addEventListener('click', downloadGaussianSplashImage);
    gaussianSplashElements.clearLogsBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearGaussianSplashLogs();
    });
}

function syncLightTransferSourceFromSingleAngle() {
    if (lightTransferState.sourceImageUrl || lightTransferState.sourceUploadedImage || lightTransferState.sourceUploadedImageBase64) return;
    if (!state.imageUrl && !state.uploadedImage && !state.uploadedImageBase64) return;

    if (state.imageUrl) {
        lightTransferState.sourceImageUrl = state.imageUrl;
        lightTransferState.sourceResolvedImageUrl = state.imageUrl;
        lightTransferState.sourceUploadedImage = null;
        lightTransferState.sourceUploadedImageBase64 = null;

        if (lightTransferElements.sourceImageUrlInput) lightTransferElements.sourceImageUrlInput.value = state.imageUrl;
        if (lightTransferElements.sourcePreviewImage) {
            lightTransferElements.sourcePreviewImage.src = state.imageUrl;
            lightTransferElements.sourcePreviewImage.classList.remove('hidden');
        }
        if (lightTransferElements.sourceUploadPlaceholder) lightTransferElements.sourceUploadPlaceholder.classList.add('hidden');
        if (lightTransferElements.sourceClearImage) lightTransferElements.sourceClearImage.classList.remove('hidden');
        if (lightTransferElements.sourceUploadZone) lightTransferElements.sourceUploadZone.classList.add('has-image');

        addLightTransferLog('Synced source image from Single Angle tab (URL)', 'info');
        return;
    }

    if (state.uploadedImageBase64 && state.uploadedImage) {
        lightTransferState.sourceUploadedImage = state.uploadedImage;
        lightTransferState.sourceUploadedImageBase64 = state.uploadedImageBase64;
        lightTransferState.sourceImageUrl = null;
        lightTransferState.sourceResolvedImageUrl = null;

        if (lightTransferElements.sourceImageUrlInput) lightTransferElements.sourceImageUrlInput.value = '';
        if (lightTransferElements.sourcePreviewImage) {
            lightTransferElements.sourcePreviewImage.src = state.uploadedImageBase64;
            lightTransferElements.sourcePreviewImage.classList.remove('hidden');
        }
        if (lightTransferElements.sourceUploadPlaceholder) lightTransferElements.sourceUploadPlaceholder.classList.add('hidden');
        if (lightTransferElements.sourceClearImage) lightTransferElements.sourceClearImage.classList.remove('hidden');
        if (lightTransferElements.sourceUploadZone) lightTransferElements.sourceUploadZone.classList.add('has-image');

        addLightTransferLog('Synced source image from Single Angle tab (uploaded file)', 'info');
    }
}

function syncGaussianSplashImageFromSingleAngle() {
    if (gaussianSplashState.imageUrl || gaussianSplashState.uploadedImage || gaussianSplashState.uploadedImageBase64) return;
    if (!state.imageUrl && !state.uploadedImage && !state.uploadedImageBase64) return;

    if (state.imageUrl) {
        gaussianSplashState.imageUrl = state.imageUrl;
        gaussianSplashState.sourceImageUrl = state.imageUrl;
        gaussianSplashState.uploadedImage = null;
        gaussianSplashState.uploadedImageBase64 = null;

        if (gaussianSplashElements.imageUrlInput) gaussianSplashElements.imageUrlInput.value = state.imageUrl;
        if (gaussianSplashElements.previewImage) {
            gaussianSplashElements.previewImage.src = state.imageUrl;
            gaussianSplashElements.previewImage.classList.remove('hidden');
        }
        if (gaussianSplashElements.uploadPlaceholder) gaussianSplashElements.uploadPlaceholder.classList.add('hidden');
        if (gaussianSplashElements.clearImage) gaussianSplashElements.clearImage.classList.remove('hidden');
        if (gaussianSplashElements.uploadZone) gaussianSplashElements.uploadZone.classList.add('has-image');

        addGaussianSplashLog('Synced image from Single Angle tab (URL)', 'info');
        return;
    }

    if (state.uploadedImageBase64 && state.uploadedImage) {
        gaussianSplashState.uploadedImage = state.uploadedImage;
        gaussianSplashState.uploadedImageBase64 = state.uploadedImageBase64;
        gaussianSplashState.imageUrl = null;
        gaussianSplashState.sourceImageUrl = null;

        if (gaussianSplashElements.imageUrlInput) gaussianSplashElements.imageUrlInput.value = '';
        if (gaussianSplashElements.previewImage) {
            gaussianSplashElements.previewImage.src = state.uploadedImageBase64;
            gaussianSplashElements.previewImage.classList.remove('hidden');
        }
        if (gaussianSplashElements.uploadPlaceholder) gaussianSplashElements.uploadPlaceholder.classList.add('hidden');
        if (gaussianSplashElements.clearImage) gaussianSplashElements.clearImage.classList.remove('hidden');
        if (gaussianSplashElements.uploadZone) gaussianSplashElements.uploadZone.classList.add('has-image');

        addGaussianSplashLog('Synced image from Single Angle tab (uploaded file)', 'info');
    }

    updateGaussianSplashButton();
}

// ===== Event Listeners Setup =====
function setupEventListeners() {
    // Image upload - click

    elements.imageInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handleImageUpload(e.target.files[0]);
        }
    });

    // Image upload - drag and drop
    elements.uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.add('drag-over');
    });

    elements.uploadZone.addEventListener('dragleave', () => {
        elements.uploadZone.classList.remove('drag-over');
    });

    elements.uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleImageUpload(e.dataTransfer.files[0]);
        }
    });

    // Clear image
    elements.clearImage.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearImage();
    });

    // URL input - load button
    elements.loadUrlBtn.addEventListener('click', () => {
        loadImageFromUrl(elements.imageUrlInput.value);
    });

    // URL input - enter key
    elements.imageUrlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadImageFromUrl(elements.imageUrlInput.value);
        }
    });

    // Sliders - continuous values matching fal.ai ranges
    // horizontal_angle: 0-360, vertical_angle: -30 to 90, zoom: 0-10
    elements.azimuthSlider.addEventListener('input', (e) => {
        state.azimuth = parseFloat(e.target.value);
        updateSliderValues();
        updatePromptDisplay();
        if (threeScene) threeScene.syncFromSliders();
    });

    elements.elevationSlider.addEventListener('input', (e) => {
        state.elevation = parseFloat(e.target.value);
        updateSliderValues();
        updatePromptDisplay();
        if (threeScene) threeScene.syncFromSliders();
    });

    elements.distanceSlider.addEventListener('input', (e) => {
        state.distance = parseFloat(e.target.value);
        updateSliderValues();
        updatePromptDisplay();
        if (threeScene) threeScene.syncFromSliders();
    });

    // Generate button
    elements.generateBtn.addEventListener('click', generateImage);

    // Download button
    elements.downloadBtn.addEventListener('click', downloadImage);

    // Clear logs button
    if (elements.clearLogs) {
        elements.clearLogs.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            clearLogs();
        });
    }
}

function setupNextSceneEventListeners() {
    nextSceneElements.imageInput?.addEventListener('change', (e) => {
        if (e.target.files?.[0]) {
            handleNextSceneImageUpload(e.target.files[0]);
        }
    });

    nextSceneElements.uploadZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        nextSceneElements.uploadZone.classList.add('drag-over');
    });

    nextSceneElements.uploadZone?.addEventListener('dragleave', () => {
        nextSceneElements.uploadZone.classList.remove('drag-over');
    });

    nextSceneElements.uploadZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        nextSceneElements.uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files?.[0]) {
            handleNextSceneImageUpload(e.dataTransfer.files[0]);
        }
    });

    nextSceneElements.clearImage?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearNextSceneImage();
    });

    nextSceneElements.loadUrlBtn?.addEventListener('click', () => {
        loadNextSceneImageFromUrl(nextSceneElements.imageUrlInput.value);
    });

    nextSceneElements.imageUrlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loadNextSceneImageFromUrl(nextSceneElements.imageUrlInput.value);
        }
    });

    nextSceneElements.prompt?.addEventListener('input', updateNextSceneButton);
    nextSceneElements.loraScale?.addEventListener('change', updateNextSceneButton);
    nextSceneElements.generateBtn?.addEventListener('click', generateNextScene);
    nextSceneElements.downloadBtn?.addEventListener('click', downloadNextSceneImage);
    nextSceneElements.clearLogsBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearNextSceneLogs();
    });
}

// ===== Tab Switching =====
function setupTabSwitching() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;

            // Update buttons
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // Update panels
            tabPanels.forEach(panel => {
                panel.classList.remove('active');
                if (panel.id === `${targetTab}-panel`) {
                    panel.classList.add('active');
                }
            });

            // Initialize multi-image scene when switching to multi-image tab
            if (targetTab === 'multi-image' && !pathThreeScene) {
                setTimeout(() => initPathThreeJS(), 100);
            }

            // Sync image from Single Angle tab into Camera Path tab automatically
            if (targetTab === 'multi-image') {
                setTimeout(() => {
                    syncPathImageFromSingleAngle();
                    updatePathButtons();
                }, 50);
            }

            if (targetTab === 'next-scene') {
                setTimeout(() => {
                    syncNextSceneImageFromSingleAngle();
                    updateNextSceneButton();
                }, 50);
            }

            if (targetTab === 'light-transfer') {
                setTimeout(() => {
                    syncLightTransferSourceFromSingleAngle();
                    updateLightTransferButton();
                }, 50);
            }

            if (targetTab === 'gaussian-splash') {
                setTimeout(() => {
                    syncGaussianSplashImageFromSingleAngle();
                    updateGaussianSplashButton();
                }, 50);
            }
        });
    });
}

function syncPathImageFromSingleAngle() {
    // If Path tab already has an image, do nothing
    if (pathState.imageUrl || pathState.uploadedImage || pathState.uploadedImageBase64) return;
    // If Single Angle tab has no image, do nothing
    if (!state.imageUrl && !state.uploadedImage && !state.uploadedImageBase64) return;

    // Copy URL-based image
    if (state.imageUrl) {
        pathState.imageUrl = state.imageUrl;
        pathState.sourceImageUrl = state.imageUrl;
        pathState.uploadedImage = null;
        pathState.uploadedImageBase64 = null;

        if (pathElements.imageUrlInput) pathElements.imageUrlInput.value = state.imageUrl;
        if (pathElements.previewImage) {
            pathElements.previewImage.src = state.imageUrl;
            pathElements.previewImage.classList.remove('hidden');
        }
        if (pathElements.uploadPlaceholder) pathElements.uploadPlaceholder.classList.add('hidden');
        if (pathElements.clearImage) pathElements.clearImage.classList.remove('hidden');
        if (pathElements.uploadZone) pathElements.uploadZone.classList.add('has-image');

        if (pathThreeScene) pathThreeScene.updateImage(state.imageUrl);
        addPathLog('Synced image from Single Angle tab (URL)', 'info');
        return;
    }

    // Copy uploaded file + base64 preview
    if (state.uploadedImageBase64 && state.uploadedImage) {
        pathState.uploadedImage = state.uploadedImage;
        pathState.uploadedImageBase64 = state.uploadedImageBase64;
        pathState.imageUrl = null;
        pathState.sourceImageUrl = null; // will be resolved (uploaded) on generation

        if (pathElements.imageUrlInput) pathElements.imageUrlInput.value = '';
        if (pathElements.previewImage) {
            pathElements.previewImage.src = state.uploadedImageBase64;
            pathElements.previewImage.classList.remove('hidden');
        }
        if (pathElements.uploadPlaceholder) pathElements.uploadPlaceholder.classList.add('hidden');
        if (pathElements.clearImage) pathElements.clearImage.classList.remove('hidden');
        if (pathElements.uploadZone) pathElements.uploadZone.classList.add('has-image');

        if (pathThreeScene) pathThreeScene.updateImage(state.uploadedImageBase64);
        addPathLog('Synced image from Single Angle tab (uploaded file)', 'info');
    }
}

function syncNextSceneImageFromSingleAngle() {
    if (nextSceneState.imageUrl || nextSceneState.uploadedImage || nextSceneState.uploadedImageBase64) return;
    if (!state.imageUrl && !state.uploadedImage && !state.uploadedImageBase64) return;

    if (state.imageUrl) {
        nextSceneState.imageUrl = state.imageUrl;
        nextSceneState.sourceImageUrl = state.imageUrl;
        nextSceneState.uploadedImage = null;
        nextSceneState.uploadedImageBase64 = null;

        if (nextSceneElements.imageUrlInput) nextSceneElements.imageUrlInput.value = state.imageUrl;
        if (nextSceneElements.previewImage) {
            nextSceneElements.previewImage.src = state.imageUrl;
            nextSceneElements.previewImage.classList.remove('hidden');
        }
        if (nextSceneElements.uploadPlaceholder) nextSceneElements.uploadPlaceholder.classList.add('hidden');
        if (nextSceneElements.clearImage) nextSceneElements.clearImage.classList.remove('hidden');
        if (nextSceneElements.uploadZone) nextSceneElements.uploadZone.classList.add('has-image');

        addNextSceneLog('Synced image from Single Angle tab (URL)', 'info');
        return;
    }

    if (state.uploadedImageBase64 && state.uploadedImage) {
        nextSceneState.uploadedImage = state.uploadedImage;
        nextSceneState.uploadedImageBase64 = state.uploadedImageBase64;
        nextSceneState.imageUrl = null;
        nextSceneState.sourceImageUrl = null;

        if (nextSceneElements.imageUrlInput) nextSceneElements.imageUrlInput.value = '';
        if (nextSceneElements.previewImage) {
            nextSceneElements.previewImage.src = state.uploadedImageBase64;
            nextSceneElements.previewImage.classList.remove('hidden');
        }
        if (nextSceneElements.uploadPlaceholder) nextSceneElements.uploadPlaceholder.classList.add('hidden');
        if (nextSceneElements.clearImage) nextSceneElements.clearImage.classList.remove('hidden');
        if (nextSceneElements.uploadZone) nextSceneElements.uploadZone.classList.add('has-image');

        addNextSceneLog('Synced image from Single Angle tab (uploaded file)', 'info');
    }
}

async function ensurePathSourceImageUrl() {
    // Prefer already resolved URL
    if (pathState.sourceImageUrl) return pathState.sourceImageUrl;

    // If user provided an image URL
    if (pathState.imageUrl) {
        pathState.sourceImageUrl = pathState.imageUrl;
        return pathState.sourceImageUrl;
    }

    // If user uploaded a file, upload once and cache URL
    if (pathState.uploadedImage) {
        addPathLog('Uploading source image (for video start frame)...', 'request');
        const url = await uploadImageToBackend(pathState.uploadedImage);
        pathState.sourceImageUrl = url;
        addPathLog(`Source image uploaded: ${url}`, 'response');
        return url;
    }

    return null;
}

// ===== Path Three.js Scene =====
let pathThreeScene = null;

function initPathThreeJS() {
    const container = pathElements.threejsContainer;
    if (!container) return;
    
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);
    
    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(4, 3.5, 4);
    camera.lookAt(0, 0.5, 0);
    
    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    
    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);
    
    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
    mainLight.position.set(5, 10, 5);
    scene.add(mainLight);
    
    // Grid
    const gridHelper = new THREE.GridHelper(5, 20, 0x1a1a2e, 0x12121a);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);
    
    // Constants
    const CENTER = new THREE.Vector3(0, 0.5, 0);
    const SPHERE_RADIUS = 2.0;
    const MIN_ZOOM = 0.0;
    const MAX_ZOOM = 10.0;
    let placementZoom = 5.0;

    function setPlacementZoom(val) {
        placementZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(val * 10) / 10));
        if (pathElements.placementZoomLabel) {
            pathElements.placementZoomLabel.textContent = `Zoom: ${placementZoom.toFixed(1)}`;
        }
    }
    setPlacementZoom(placementZoom);
    
    // Subject plane
    const planeGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const planeMat = new THREE.MeshBasicMaterial({ 
        color: 0x3a3a4a,
        side: THREE.DoubleSide
    });
    const imagePlane = new THREE.Mesh(planeGeo, planeMat);
    imagePlane.position.copy(CENTER);
    scene.add(imagePlane);
    
    // Frame
    const frameGeo = new THREE.EdgesGeometry(planeGeo);
    const frameMat = new THREE.LineBasicMaterial({ color: 0xE93D82 });
    const imageFrame = new THREE.LineSegments(frameGeo, frameMat);
    imageFrame.position.copy(CENTER);
    scene.add(imageFrame);
    
    // Clickable sphere (wireframe)
    const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 32, 24);
    const sphereMat = new THREE.MeshBasicMaterial({ 
        color: 0xE93D82, 
        wireframe: true, 
        transparent: true, 
        opacity: 0.15 
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.copy(CENTER);
    scene.add(sphere);
    
    // Waypoint markers group
    const waypointMarkers = new THREE.Group();
    scene.add(waypointMarkers);

    // Ghost marker for preview (hover + scroll zoom)
    const ghostMarkerGeo = new THREE.SphereGeometry(0.12, 16, 16);
    const ghostMarkerMat = new THREE.MeshStandardMaterial({
        color: 0xFFB800,
        emissive: 0xFFB800,
        emissiveIntensity: 0.6,
        metalness: 0.2,
        roughness: 0.5,
        transparent: true,
        opacity: 0.9
    });
    const ghostMarker = new THREE.Mesh(ghostMarkerGeo, ghostMarkerMat);
    ghostMarker.visible = false;
    scene.add(ghostMarker);

    const ghostGlowGeo = new THREE.SphereGeometry(0.2, 16, 16);
    const ghostGlowMat = new THREE.MeshBasicMaterial({
        color: 0xFFB800,
        transparent: true,
        opacity: 0.2
    });
    const ghostGlow = new THREE.Mesh(ghostGlowGeo, ghostGlowMat);
    ghostGlow.visible = false;
    scene.add(ghostGlow);

    let lastHoverDir = null; // THREE.Vector3
    
    // Path line
    let pathLine = null;
    
    function updatePathLine() {
        if (pathLine) {
            scene.remove(pathLine);
            pathLine = null;
        }
        
        if (pathState.waypoints.length < 2) return;
        
        const points = pathState.waypoints.map(wp => {
            const azRad = (wp.azimuth * Math.PI) / 180;
            const elRad = (wp.elevation * Math.PI) / 180;
            const dist = 2.0 - (wp.distance / 10) * 1.2;
            return new THREE.Vector3(
                dist * Math.sin(azRad) * Math.cos(elRad) + CENTER.x,
                dist * Math.sin(elRad) + CENTER.y,
                dist * Math.cos(azRad) * Math.cos(elRad) + CENTER.z
            );
        });
        
        const curve = new THREE.CatmullRomCurve3(points);
        const tubeGeo = new THREE.TubeGeometry(curve, 64, 0.03, 8, false);
        const tubeMat = new THREE.MeshBasicMaterial({ 
            color: 0x00FFD0, 
            transparent: true, 
            opacity: 0.8 
        });
        pathLine = new THREE.Mesh(tubeGeo, tubeMat);
        scene.add(pathLine);
    }
    
    function updateWaypointMarkers() {
        // Clear existing markers
        while (waypointMarkers.children.length > 0) {
            waypointMarkers.remove(waypointMarkers.children[0]);
        }
        
        // Create markers for each waypoint
        pathState.waypoints.forEach((wp, index) => {
            const azRad = (wp.azimuth * Math.PI) / 180;
            const elRad = (wp.elevation * Math.PI) / 180;
            const dist = 2.0 - (wp.distance / 10) * 1.2;
            
            const x = dist * Math.sin(azRad) * Math.cos(elRad) + CENTER.x;
            const y = dist * Math.sin(elRad) + CENTER.y;
            const z = dist * Math.cos(azRad) * Math.cos(elRad) + CENTER.z;
            
            // Marker sphere
            const markerGeo = new THREE.SphereGeometry(0.12, 16, 16);
            const color = wp.generatedImageUrl ? 0x3DE9B4 : 0xE93D82;
            const markerMat = new THREE.MeshStandardMaterial({ 
                color: color,
                emissive: color,
                emissiveIntensity: 0.6,
                metalness: 0.3,
                roughness: 0.4
            });
            const marker = new THREE.Mesh(markerGeo, markerMat);
            marker.position.set(x, y, z);
            marker.userData = { waypointIndex: index };
            waypointMarkers.add(marker);
            
            // Glow
            const glowGeo = new THREE.SphereGeometry(0.18, 16, 16);
            const glowMat = new THREE.MeshBasicMaterial({ 
                color: color, 
                transparent: true, 
                opacity: 0.25 
            });
            const glow = new THREE.Mesh(glowGeo, glowMat);
            glow.position.set(x, y, z);
            waypointMarkers.add(glow);
        });
        
        updatePathLine();
    }
    
    // Raycaster for clicking
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    
    function getMouse(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function zoomToVisualDist(zoom) {
        // Same mapping used in marker placement: higher zoom => closer
        return 2.0 - (zoom / 10) * 1.2;
    }

    function updateGhostFromDir(dir) {
        if (!dir) return;
        const dist = zoomToVisualDist(placementZoom);
        const pos = dir.clone().multiplyScalar(dist).add(CENTER);
        ghostMarker.position.copy(pos);
        ghostGlow.position.copy(pos);
        ghostMarker.visible = true;
        ghostGlow.visible = true;
    }

    function hideGhost() {
        ghostMarker.visible = false;
        ghostGlow.visible = false;
        lastHoverDir = null;
    }

    function onPointerMove(event) {
        getMouse(event);
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(sphere);
        if (intersects.length > 0) {
            const point = intersects[0].point;
            const dir = point.clone().sub(CENTER).normalize();
            lastHoverDir = dir;
            updateGhostFromDir(dir);
            renderer.domElement.style.cursor = 'crosshair';
        } else {
            renderer.domElement.style.cursor = 'default';
            hideGhost();
        }
    }

    function onWheel(event) {
        // Scroll up => zoom in (higher zoom), scroll down => zoom out
        if (!lastHoverDir) return;
        event.preventDefault();
        const delta = Math.sign(event.deltaY);
        const step = 0.5;
        setPlacementZoom(placementZoom + (delta > 0 ? -step : step));
        updateGhostFromDir(lastHoverDir);
    }

    function onClick(event) {
        getMouse(event);
        raycaster.setFromCamera(mouse, camera);
        
        // Check if clicked on sphere
        const intersects = raycaster.intersectObject(sphere);
        if (intersects.length > 0 && pathState.waypoints.length < CONFIG.MAX_WAYPOINTS) {
            const point = intersects[0].point;
            
            // Calculate angles from intersection point
            const relX = point.x - CENTER.x;
            const relY = point.y - CENTER.y;
            const relZ = point.z - CENTER.z;
            
            let azimuth = Math.atan2(relX, relZ) * (180 / Math.PI);
            if (azimuth < 0) azimuth += 360;
            
            const horizontalDist = Math.sqrt(relX * relX + relZ * relZ);
            let elevation = Math.atan2(relY, horizontalDist) * (180 / Math.PI);
            elevation = Math.max(-30, Math.min(90, elevation));
            
            // Add waypoint
            const waypoint = {
                id: `wp-${Date.now()}`,
                azimuth: Math.round(azimuth),
                elevation: Math.round(elevation),
                distance: placementZoom,
                generatedImageUrl: null
            };
            
            pathState.waypoints.push(waypoint);
            updateWaypointMarkers();
            updateWaypointsList();
            updatePathButtons();
            addPathLog(`Added waypoint ${pathState.waypoints.length}: Az=${waypoint.azimuth}°, El=${waypoint.elevation}°`, 'info');
        }
    }
    
    renderer.domElement.addEventListener('mousemove', onPointerMove);
    renderer.domElement.addEventListener('mouseleave', hideGhost);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.style.cursor = 'crosshair';
    
    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        renderer.render(scene, camera);
    }
    animate();
    
    // Resize
    function onResize() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);
    
    // Public API
    pathThreeScene = {
        updateWaypoints: updateWaypointMarkers,
        updateImage: (url) => {
            if (url) {
                const img = new Image();
                if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
                img.onload = () => {
                    const tex = new THREE.Texture(img);
                    tex.needsUpdate = true;
                    tex.colorSpace = THREE.SRGBColorSpace;
                    planeMat.map = tex;
                    planeMat.color.set(0xffffff);
                    planeMat.needsUpdate = true;
                    
                    const ar = img.width / img.height;
                    const maxSize = 1.5;
                    if (ar > 1) {
                        imagePlane.scale.set(maxSize, maxSize / ar, 1);
                        imageFrame.scale.set(maxSize, maxSize / ar, 1);
                    } else {
                        imagePlane.scale.set(maxSize * ar, maxSize, 1);
                        imageFrame.scale.set(maxSize * ar, maxSize, 1);
                    }
                };
                img.src = url;
            } else {
                planeMat.map = null;
                planeMat.color.set(0x3a3a4a);
                planeMat.needsUpdate = true;
                imagePlane.scale.set(1, 1, 1);
                imageFrame.scale.set(1, 1, 1);
            }
        }
    };

    // If an image was uploaded/synced before the 3D scene initialized, apply it now.
    const initialUrl = pathState.uploadedImageBase64 || pathState.imageUrl || null;
    if (initialUrl) {
        try {
            pathThreeScene.updateImage(initialUrl);
        } catch (_) {
            // no-op; scene will stay with placeholder
        }
    }
}

// ===== Path Logging =====
function addPathLog(message, type = 'info') {
    const container = pathElements.logsContainer;
    if (!container) return;
    
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    
    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    timestamp.textContent = `[${getTimestamp()}]`;
    entry.appendChild(timestamp);
    
    let messageText = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
    entry.appendChild(document.createTextNode(messageText));
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
}

function showPathStatus(message, type = 'info') {
    const el = pathElements.statusMessage;
    if (!el) return;
    el.textContent = message;
    el.className = `status-message ${type}`;
    el.classList.remove('hidden');
    if (type === 'success') setTimeout(() => el.classList.add('hidden'), 5000);
}

// Surface runtime errors into Path logs (helps debug “nothing happens”)
window.addEventListener('error', (e) => {
    try {
        addPathLog(`JS Error: ${e.message}`, 'error');
        if (e.filename) addPathLog(`at ${e.filename}:${e.lineno}:${e.colno}`, 'error');
    } catch (_) {}
});

window.addEventListener('unhandledrejection', (e) => {
    try {
        addPathLog(`Unhandled Promise Rejection: ${formatError(e.reason)}`, 'error');
    } catch (_) {}
});

// ===== Waypoints UI =====
function updateWaypointsList() {
    const list = pathElements.waypointsList;
    const count = pathElements.waypointCount;
    if (!list) return;
    
    count.textContent = `(${pathState.waypoints.length}/${CONFIG.MAX_WAYPOINTS})`;
    
    if (pathState.waypoints.length === 0) {
        list.innerHTML = `<div class="waypoints-empty"><p>Click on the sphere above to add camera positions</p></div>`;
        return;
    }
    
    list.innerHTML = pathState.waypoints.map((wp, i) => `
        <div class="waypoint-item ${wp.generatedImageUrl ? 'completed' : ''}" data-index="${i}">
            <div class="waypoint-number">${i + 1}</div>
            <div class="waypoint-info">
                Az: <span>${wp.azimuth}°</span> | El: <span>${wp.elevation}°</span> | Zoom: <span>${wp.distance}</span>
            </div>
            <div class="waypoint-actions">
                <button class="waypoint-action-btn delete" data-action="delete" data-index="${i}" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
    
    // Add delete handlers
    list.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            pathState.waypoints.splice(index, 1);
            if (pathThreeScene) pathThreeScene.updateWaypoints();
            updateWaypointsList();
            updatePathButtons();
            addPathLog(`Removed waypoint ${index + 1}`, 'info');
        });
    });
}

function updatePathButtons() {
    const hasImage = pathState.uploadedImage || pathState.imageUrl;
    const hasEnoughWaypoints = pathState.waypoints.length >= CONFIG.MIN_WAYPOINTS;

    if (pathElements.generateKeyframesBtn) {
        pathElements.generateKeyframesBtn.disabled = !hasImage || !hasEnoughWaypoints || pathState.isGeneratingKeyframes;
    }

    const allKeyframesGenerated = pathState.waypoints.length >= 2 && pathState.waypoints.every(wp => wp.generatedImageUrl);
    if (pathElements.generateVideoBtn) {
        pathElements.generateVideoBtn.disabled = !allKeyframesGenerated || pathState.isGeneratingVideos;
    }

    if (pathElements.downloadAllBtn) {
        pathElements.downloadAllBtn.classList.toggle('hidden', !allKeyframesGenerated);
    }
}

// ===== Path Image Upload =====
function handlePathImageUpload(file) {
    const validation = validateImageFile(file);
    if (!validation.valid) {
        showPathStatus(validation.error, 'error');
        return;
    }
    
    addPathLog(`Uploading: ${file.name}`, 'info');
    pathState.imageUrl = null;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        pathState.uploadedImage = file;
        pathState.uploadedImageBase64 = e.target.result;
        pathState.sourceImageUrl = null; // will be resolved (uploaded) when needed
        
        pathElements.previewImage.src = e.target.result;
        pathElements.previewImage.classList.remove('hidden');
        pathElements.uploadPlaceholder.classList.add('hidden');
        pathElements.clearImage.classList.remove('hidden');
        pathElements.uploadZone.classList.add('has-image');
        
        if (pathThreeScene) pathThreeScene.updateImage(e.target.result);
        updatePathButtons();
    };
    reader.readAsDataURL(file);
}

function clearPathImage() {
    pathState.uploadedImage = null;
    pathState.uploadedImageBase64 = null;
    pathState.imageUrl = null;
    pathState.sourceImageUrl = null;
    
    pathElements.previewImage.src = '';
    pathElements.previewImage.classList.add('hidden');
    pathElements.uploadPlaceholder.classList.remove('hidden');
    pathElements.clearImage.classList.add('hidden');
    pathElements.uploadZone.classList.remove('has-image');
    pathElements.imageUrlInput.value = '';
    
    if (pathThreeScene) pathThreeScene.updateImage(null);
    updatePathButtons();
}

function loadPathImageFromUrl(url) {
    const validation = validateImageUrl(url);
    if (!validation.valid) {
        showPathStatus(validation.error, 'error');
        return;
    }
    
    url = url.trim();
    addPathLog(`Loading URL: ${url}`, 'info');
    
    pathState.uploadedImage = null;
    pathState.uploadedImageBase64 = null;
    pathState.imageUrl = url;
    pathState.sourceImageUrl = url;
    
    pathElements.clearImage.classList.remove('hidden');
    pathElements.uploadZone.classList.add('has-image');
    
    const img = new Image();
    img.onload = () => {
        pathElements.previewImage.src = url;
        pathElements.previewImage.classList.remove('hidden');
        pathElements.uploadPlaceholder.classList.add('hidden');
    };
    img.src = url;
    
    if (pathThreeScene) pathThreeScene.updateImage(url);
    updatePathButtons();
}

// ===== Generate Keyframes =====
async function generateKeyframes() {
    addPathLog(`Generate keyframes clicked. waypoints=${pathState.waypoints.length}, hasPathImage=${!!(pathState.imageUrl || pathState.uploadedImage)}`, 'info');

    // If user uploaded only in Single Angle tab, auto-sync it now
    if (!pathState.imageUrl && !pathState.uploadedImage) {
        syncPathImageFromSingleAngle();
    }
    
    if (pathState.waypoints.length < CONFIG.MIN_WAYPOINTS) {
        showPathStatus(`Add at least ${CONFIG.MIN_WAYPOINTS} waypoints`, 'error');
        return;
    }

    if (!pathState.imageUrl && !pathState.uploadedImage) {
        showPathStatus('Please upload an image (in Camera Path tab) or switch from Single Angle with an image loaded', 'error');
        addPathLog('Keyframe generation blocked: no image found for Camera Path', 'error');
        return;
    }
    
    pathState.isGeneratingKeyframes = true;
    updatePathButtons();

    showPathStatus('Generating keyframes...', 'info');
    // Render placeholder slots immediately (one per waypoint)
    updateGallery();
    
    pathElements.generateKeyframesBtn.classList.add('generating');
    pathElements.generateKeyframesBtn.querySelector('.btn-text').textContent = 'Generating...';
    pathElements.generateKeyframesBtn.querySelector('.btn-loader').classList.remove('hidden');
    pathElements.keyframeProgress.classList.remove('hidden');
    pathElements.keyframeProgressFill.style.width = '0%';
    pathElements.keyframeProgressText.textContent = `0/${pathState.waypoints.length}`;
    
    let imageUrl;
    try {
        if (pathState.imageUrl) {
            imageUrl = pathState.imageUrl;
            pathState.sourceImageUrl = imageUrl;
        } else {
            addPathLog('Uploading source image...', 'request');
            imageUrl = await uploadImageToBackend(pathState.uploadedImage);
            addPathLog(`Uploaded: ${imageUrl}`, 'response');
            pathState.sourceImageUrl = imageUrl;
        }
    } catch (err) {
        showPathStatus('Failed to upload image', 'error');
        addPathLog(`Upload error: ${formatError(err)}`, 'error');
        pathState.isGeneratingKeyframes = false;
        resetKeyframeUI();
        return;
    }
    
    const total = pathState.waypoints.length;
    let completed = 0;
    
    for (let i = 0; i < pathState.waypoints.length; i++) {
        const wp = pathState.waypoints[i];
        
        pathElements.keyframeProgressFill.style.width = `${(i / total) * 100}%`;
        pathElements.keyframeProgressText.textContent = `${i + 1}/${total}`;
        
        addPathLog(`Generating keyframe ${i + 1}/${total}: Az=${wp.azimuth}°, El=${wp.elevation}°`, 'request');
        
        try {
            const result = await apiRequest('/api/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    imageUrl,
                    horizontal_angle: wp.azimuth,
                    vertical_angle: wp.elevation,
                    zoom: wp.distance
                })
            });

            const outputUrl = result?.imageUrl;

            if (outputUrl) {
                wp.generatedImageUrl = outputUrl;
                completed++;
                addPathLog(`Keyframe ${i + 1} done: ${outputUrl.substring(0, 50)}...`, 'response');
            } else {
                addPathLog(`Keyframe ${i + 1} failed: no image in response`, 'error');
            }
        } catch (err) {
            addPathLog(`Keyframe ${i + 1} error: ${formatError(err)}`, 'error');
        }
        
        if (pathThreeScene) pathThreeScene.updateWaypoints();
        updateWaypointsList();
        updateGallery();
    }
    
    pathElements.keyframeProgressFill.style.width = '100%';
    pathElements.keyframeProgressText.textContent = `${completed}/${total}`;
    
    pathState.isGeneratingKeyframes = false;
    resetKeyframeUI();
    updatePathButtons();
    
    if (completed === total) {
        showPathStatus('All keyframes generated!', 'success');
    } else {
        showPathStatus(`Generated ${completed}/${total} keyframes`, 'warn');
    }
}

function resetKeyframeUI() {
    pathElements.generateKeyframesBtn.classList.remove('generating');
    pathElements.generateKeyframesBtn.querySelector('.btn-text').textContent = 'Generate All Keyframes';
    pathElements.generateKeyframesBtn.querySelector('.btn-loader').classList.add('hidden');
}

// ===== Gallery =====
function updateGallery() {
    const gallery = pathElements.gallery;
    if (!gallery) return;
    
    const generatedWaypoints = pathState.waypoints.filter(wp => wp.generatedImageUrl);
    
    // If we're generating (or have at least one result), render placeholders for every waypoint
    // so the user sees N slots immediately.
    if (pathState.waypoints.length > 0 && (pathState.isGeneratingKeyframes || generatedWaypoints.length > 0)) {
        gallery.innerHTML = pathState.waypoints.map((wp, i) => {
            if (!wp.generatedImageUrl) {
                return `
                    <div class="gallery-item">
                        <div class="gallery-item-loading">
                            <svg class="spinner" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="31.4" stroke-dashoffset="10"/>
                            </svg>
                        </div>
                    </div>
                `;
            }
            return `
                <div class="gallery-item">
                    <img src="${wp.generatedImageUrl}" alt="Keyframe ${i + 1}">
                    <div class="gallery-item-overlay">
                        <span class="gallery-item-label">Keyframe ${i + 1}</span>
                        <button class="gallery-item-download" data-url="${wp.generatedImageUrl}" data-index="${i}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Add download handlers (only applies to generated ones)
        gallery.querySelectorAll('.gallery-item-download').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const url = btn.dataset.url;
                const index = btn.dataset.index;
                try {
                    const response = await fetch(url);
                    const blob = await response.blob();
                    const blobUrl = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = `keyframe-${parseInt(index) + 1}.png`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(blobUrl);
                } catch (err) {
                    window.open(url, '_blank');
                }
            });
        });

        return;
    }

    if (generatedWaypoints.length === 0) {
        gallery.innerHTML = `
            <div class="gallery-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
                    <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
                </svg>
                <p>Generated keyframes will appear here</p>
            </div>
        `;
        return;
    }
}

// ===== Download All as ZIP =====
async function downloadAllAsZip() {
    const generated = pathState.waypoints.filter(wp => wp.generatedImageUrl);
    if (generated.length === 0) return;
    
    addPathLog('Creating ZIP file...', 'info');
    showPathStatus('Preparing download...', 'info');
    
    try {
        const zip = new JSZip();
        
        for (let i = 0; i < pathState.waypoints.length; i++) {
            const wp = pathState.waypoints[i];
            if (!wp.generatedImageUrl) continue;
            
            const response = await fetch(wp.generatedImageUrl);
            const blob = await response.blob();
            zip.file(`keyframe-${i + 1}.png`, blob);
        }
        
        const content = await zip.generateAsync({ type: 'blob' });
        const url = window.URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `camera-path-keyframes-${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showPathStatus('Downloaded!', 'success');
        addPathLog('ZIP download complete', 'info');
    } catch (err) {
        showPathStatus('Download failed', 'error');
        addPathLog(`ZIP error: ${formatError(err)}`, 'error');
    }
}

// ===== Easing Functions =====
const easings = {
    'linear': t => t,
    'ease-in-out': t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
    'ease-out': t => 1 - Math.pow(1 - t, 3),
    'bounce': t => {
        const n1 = 7.5625;
        const d1 = 2.75;
        if (t < 1 / d1) return n1 * t * t;
        if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
        if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
        return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }
};

// ===== Generate Transition Video =====
async function generateTransitionVideo() {
    // Include the original input image as the FIRST frame, then the generated keyframes.
    const genKeyframes = pathState.waypoints.filter(wp => wp.generatedImageUrl);
    const sourceUrl = await ensurePathSourceImageUrl();
    if (!sourceUrl) {
        showPathStatus('Missing input image for video start frame. Go to Multi-image and upload an image first.', 'error');
        return;
    }
    // Use first keyframe's params to drive direction for the source frame (purely for transition heuristics)
    const ref = genKeyframes[0] || { azimuth: 0, elevation: 0, distance: 5 };
    const keyframes = [{ ...ref, generatedImageUrl: sourceUrl, isSource: true }, ...genKeyframes];
    addPathLog(`Quick video frames: source+${genKeyframes.length} keyframes = ${keyframes.length}`, 'info');
    if (keyframes.length < 2) {
        showPathStatus('Need at least 2 generated keyframes', 'error');
        return;
    }
    
    pathState.isGeneratingVideos = true;
    updatePathButtons();
    
    pathElements.generateVideoBtn.classList.add('generating');
    pathElements.generateVideoBtn.querySelector('.btn-text').textContent = 'Rendering...';
    pathElements.generateVideoBtn.querySelector('.btn-loader').classList.remove('hidden');
    pathElements.videoProgress.classList.remove('hidden');
    
    const totalDuration = parseInt(pathElements.videoDuration?.value || '5') * 1000;
    const fps = parseInt(pathElements.videoFps?.value || '30');
    const transitionStyle = pathElements.transitionStyle?.value || 'crane-zoom';
    const easeType = pathElements.easeType?.value || 'ease-in-out';
    const ease = easings[easeType] || easings['ease-in-out'];
    
    addPathLog(`Creating ${totalDuration/1000}s video at ${fps}fps with ${transitionStyle} transitions`, 'info');
    addPathLog(`Rendering in real-time (will take ~${totalDuration/1000}s)...`, 'info');
    
    const canvas = pathElements.videoCanvas;
    const ctx = canvas.getContext('2d');
    
    // Set canvas size (720p)
    canvas.width = 1280;
    canvas.height = 720;
    
    // Load all images first
    const images = [];
    for (const wp of keyframes) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = wp.generatedImageUrl;
        });
        images.push(img);
    }
    
    addPathLog(`Loaded ${images.length} keyframe images`, 'info');
    
    // Calculate transition parameters based on angle changes
    const transitions = [];
    for (let i = 0; i < keyframes.length - 1; i++) {
        const from = keyframes[i];
        const to = keyframes[i + 1];
        const azDiff = to.azimuth - from.azimuth;
        const elDiff = to.elevation - from.elevation;
        const zoomDiff = to.distance - from.distance;
        
        transitions.push({
            fromImg: images[i],
            toImg: images[i + 1],
            azDiff,
            elDiff,
            zoomDiff,
            // Direction for pan/zoom
            panX: azDiff > 0 ? 1 : -1,
            panY: elDiff > 0 ? -1 : 1,
            zoomDir: zoomDiff > 0 ? 1 : -1
        });
    }
    
    const totalFrames = Math.floor(totalDuration / 1000 * fps);
    const framesPerTransition = Math.floor(totalFrames / transitions.length);
    
    // Setup MediaRecorder
    const stream = canvas.captureStream(fps);
    const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: 8000000
    });
    
    const chunks = [];
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    
    const videoPromise = new Promise((resolve) => {
        mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'video/webm' });
            resolve(blob);
        };
    });
    
    mediaRecorder.start();
    
    // Frame timing - must match real-time for MediaRecorder
    const frameInterval = 1000 / fps;
    
    // Render frames
    let currentFrame = 0;
    
    for (let t = 0; t < transitions.length; t++) {
        const trans = transitions[t];
        
        for (let f = 0; f < framesPerTransition; f++) {
            const frameStart = performance.now();
            const progress = f / framesPerTransition;
            const easedProgress = ease(progress);
            
            // Update progress UI
            const overallProgress = (currentFrame / totalFrames) * 100;
            pathElements.videoProgressFill.style.width = `${overallProgress}%`;
            pathElements.videoProgressText.textContent = `Frame ${currentFrame}/${totalFrames}`;
            
            // Clear canvas
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Apply transition effect
            if (transitionStyle === 'crane-zoom') {
                // Crane zoom: zoom out from current, zoom in to next with pan
                const zoomOut = 1 + easedProgress * 0.3;
                const zoomIn = 1.3 - easedProgress * 0.3;
                const panOffset = easedProgress * 100 * trans.panX;
                
                // Draw "from" image (zooming out, fading)
                ctx.globalAlpha = 1 - easedProgress;
                drawImageZoomed(ctx, trans.fromImg, canvas.width, canvas.height, zoomOut, panOffset, 0);
                
                // Draw "to" image (zooming in, appearing)
                ctx.globalAlpha = easedProgress;
                drawImageZoomed(ctx, trans.toImg, canvas.width, canvas.height, zoomIn, -panOffset, 0);
                
            } else if (transitionStyle === 'smooth-pan') {
                // Smooth pan: slide images
                const slideX = easedProgress * canvas.width * trans.panX;
                
                ctx.globalAlpha = 1;
                drawImageZoomed(ctx, trans.fromImg, canvas.width, canvas.height, 1, -slideX, 0);
                drawImageZoomed(ctx, trans.toImg, canvas.width, canvas.height, 1, canvas.width - slideX, 0);
                
            } else if (transitionStyle === 'whip-pan') {
                // Whip pan: fast motion blur effect
                const speed = Math.sin(easedProgress * Math.PI) * 50;
                const blur = Math.abs(speed) > 20 ? 0.7 : 1;
                
                ctx.globalAlpha = blur;
                if (easedProgress < 0.5) {
                    drawImageZoomed(ctx, trans.fromImg, canvas.width, canvas.height, 1, -speed * 3, 0);
                } else {
                    drawImageZoomed(ctx, trans.toImg, canvas.width, canvas.height, 1, speed * 3, 0);
                }
                
            } else if (transitionStyle === 'dolly-zoom') {
                // Dolly zoom: opposite zoom directions
                const zoom1 = 1 + easedProgress * 0.5;
                const zoom2 = 1.5 - easedProgress * 0.5;
                
                ctx.globalAlpha = 1 - easedProgress;
                drawImageZoomed(ctx, trans.fromImg, canvas.width, canvas.height, zoom1, 0, 0);
                
                ctx.globalAlpha = easedProgress;
                drawImageZoomed(ctx, trans.toImg, canvas.width, canvas.height, zoom2, 0, 0);
            }
            
            ctx.globalAlpha = 1;
            currentFrame++;
            
            // Wait for proper frame timing (real-time for MediaRecorder)
            const elapsed = performance.now() - frameStart;
            const waitTime = Math.max(1, frameInterval - elapsed);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
    
    // Hold on last frame for 0.5 seconds
    const holdFrames = Math.floor(fps * 0.5);
    for (let i = 0; i < holdFrames; i++) {
        const frameStart = performance.now();
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawImageZoomed(ctx, images[images.length - 1], canvas.width, canvas.height, 1, 0, 0);
        
        const elapsed = performance.now() - frameStart;
        const waitTime = Math.max(1, frameInterval - elapsed);
        await new Promise(r => setTimeout(r, waitTime));
    }
    
    mediaRecorder.stop();
    
    const videoBlob = await videoPromise;
    const videoUrl = URL.createObjectURL(videoBlob);
    
    pathState.generatedVideoUrl = videoUrl;
    pathState.generatedVideoBlob = videoBlob;
    pathState.generatedVideoUrlMp4 = null;
    pathState.generatedVideoBlobMp4 = null;
    
    // Show video
    pathElements.finalVideo.src = videoUrl;
    pathElements.finalVideo.classList.remove('hidden');
    pathElements.videoEmptyState.classList.add('hidden');
    pathElements.downloadVideoBtn.classList.remove('hidden');
    
    pathElements.videoProgressFill.style.width = '100%';
    pathElements.videoProgressText.textContent = 'Complete!';
    
    pathState.isGeneratingVideos = false;
    pathElements.generateVideoBtn.classList.remove('generating');
    pathElements.generateVideoBtn.querySelector('.btn-text').textContent = 'Create Video';
    pathElements.generateVideoBtn.querySelector('.btn-loader').classList.add('hidden');
    updatePathButtons();
    
    showPathStatus('Video created!', 'success');
    addPathLog('Video rendering complete', 'response');

    // Also create an MP4 in the background (optional but requested)
    try {
        showPathStatus('Transcoding to MP4...', 'info');
        const mp4Blob = await transcodeWebmToMp4(videoBlob, 'Quick');
        pathState.generatedVideoBlobMp4 = mp4Blob;
        pathState.generatedVideoUrlMp4 = URL.createObjectURL(mp4Blob);
        pathElements.finalVideo.src = pathState.generatedVideoUrlMp4;
        showPathStatus('MP4 ready!', 'success');
        addPathLog('Quick: MP4 transcoding complete', 'response');
    } catch (e) {
        addPathLog(`Quick: MP4 transcoding failed, keeping WebM. ${formatError(e)}`, 'warn');
    }
}

// Helper: Draw image with zoom and offset
function drawImageZoomed(ctx, img, canvasW, canvasH, zoom, offsetX, offsetY) {
    const imgAspect = img.width / img.height;
    const canvasAspect = canvasW / canvasH;
    
    let drawW, drawH;
    if (imgAspect > canvasAspect) {
        drawH = canvasH * zoom;
        drawW = drawH * imgAspect;
    } else {
        drawW = canvasW * zoom;
        drawH = drawW / imgAspect;
    }
    
    const x = (canvasW - drawW) / 2 + offsetX;
    const y = (canvasH - drawH) / 2 + offsetY;
    
    ctx.drawImage(img, x, y, drawW, drawH);
}

// ===== Generate AI Video (Seedance) =====
// Generates video for EACH consecutive keyframe pair, speeds up 4x, stitches together
async function generateAIVideo() {
    const genKeyframes = pathState.waypoints.filter(wp => wp.generatedImageUrl);
    if (genKeyframes.length < 1) {
        showPathStatus('Need at least 1 generated keyframe (run Multi-image first)', 'error');
        return;
    }

    const sourceUrl = await ensurePathSourceImageUrl();
    if (!sourceUrl) {
        showPathStatus('Missing input image for video start frame. Go to Multi-image and upload an image first.', 'error');
        return;
    }

    const ref = genKeyframes[0];
    const keyframes = [{ ...ref, generatedImageUrl: sourceUrl, isSource: true }, ...genKeyframes];
    addPathLog(`AI video frames: source+${genKeyframes.length} keyframes = ${keyframes.length}`, 'info');

    pathState.isGeneratingVideos = true;
    pathState.segmentVideos = [];
    updatePathButtons();

    pathElements.generateVideoBtn.classList.add('generating');
    pathElements.generateVideoBtn.querySelector('.btn-text').textContent = 'Generating segments...';
    pathElements.generateVideoBtn.querySelector('.btn-loader').classList.remove('hidden');
    pathElements.videoProgress.classList.remove('hidden');

    const prompt = pathElements.aiPrompt?.value || 'The camera very slowly and smoothly lowers on a boom. The subject moves barely moves, and is extremely deliberate and thoughtful in his movement.';
    const resolution = pathElements.aiResolution?.value || '720p';
    const modelKey = pathElements.aiVideoModel?.value || 'seedance';

    if (modelKey === 'veo31') {
        const first = keyframes[0];
        const last = keyframes[keyframes.length - 1];

        addPathLog(`AI video model: ${modelKey}`, 'info');
        addPathLog('Veo mode: generating one video from first→last keyframe.', 'info');

        try {
            const response = await apiRequest('/api/video/first-last', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    modelKey,
                    prompt,
                    first_frame_url: first.generatedImageUrl,
                    last_frame_url: last.generatedImageUrl
                })
            });

            const videoUrl = response?.videoUrl;
            if (!videoUrl) throw new Error('No video in response');

            pathState.generatedVideoUrl = videoUrl;
            pathState.generatedVideoBlob = null;
            pathState.generatedVideoUrlMp4 = videoUrl;
            pathState.generatedVideoBlobMp4 = null;

            pathElements.finalVideo.src = videoUrl;
            pathElements.finalVideo.classList.remove('hidden');
            pathElements.videoEmptyState.classList.add('hidden');
            pathElements.downloadVideoBtn.classList.remove('hidden');

            showPathStatus('Veo video generated!', 'success');
            addPathLog(`Veo video ready: ${videoUrl.substring(0, 60)}...`, 'response');
        } catch (err) {
            showPathStatus(`Veo failed: ${formatError(err)}`, 'error');
            addPathLog(`Veo error: ${formatError(err)}`, 'error');
        } finally {
            resetVideoUI();
        }

        return;
    }

    const pairSeconds = parseFloat(pathElements.aiPairSeconds?.value || '1');
    const seedanceSegmentSeconds = 4;
    const speedMultiplier = seedanceSegmentSeconds / Math.max(0.5, pairSeconds);
    const loopPath = !!pathElements.aiLoopPath?.checked;
    const totalSegments = loopPath ? keyframes.length : (keyframes.length - 1);

    addPathLog(`AI video model: ${modelKey}`, 'info');
    addPathLog(`Segments to generate: ${totalSegments} (loop=${loopPath}) | expected_duration≈${(totalSegments * pairSeconds).toFixed(1)}s`, 'info');
    addPathLog(`Prompt: "${prompt}"`, 'info');

    const keyframeUrls = keyframes.map(k => k.generatedImageUrl);
    const cacheKey = buildSeedanceSegmentsCacheKey({
        keyframeUrls,
        prompt,
        resolution,
        seedanceSeconds: seedanceSegmentSeconds,
        loop: loopPath,
        modelKey
    });

    let segmentUrls = [];
    const cache = loadAICache();
    const cachedEntry = cache?.[cacheKey];

    if (cachedEntry?.segmentUrls?.length === totalSegments) {
        segmentUrls = cachedEntry.segmentUrls.slice(0);
        addPathLog(`Cache hit: reusing ${segmentUrls.length} Seedance segments (no model calls).`, 'info');
        pathElements.videoProgressFill.style.width = '20%';
        pathElements.videoProgressText.textContent = 'Using cached segments...';
    } else {
        for (let i = 0; i < totalSegments; i++) {
            const startFrame = keyframes[i];
            const endFrame = keyframes[(i + 1) % keyframes.length];
            const endLabel = (i + 1) < keyframes.length ? (i + 2) : 1;

            pathElements.videoProgressFill.style.width = `${((i + 0.5) / totalSegments) * 70}%`;
            pathElements.videoProgressText.textContent = `Segment ${i + 1}/${totalSegments}`;
            addPathLog(`Segment ${i + 1}: Frame ${i + 1} (Az=${startFrame.azimuth}°) → Frame ${endLabel} (Az=${endFrame.azimuth}°)`, 'request');

            try {
                if (modelKey === 'ltx2') {
                    throw new Error('LTX-2 image-to-video does not support start+end frame pairs. Choose Seedance or Kling 2.6 for keyframe-to-keyframe motion.');
                }

                const body = {
                    modelKey,
                    prompt,
                    image_url: startFrame.generatedImageUrl,
                    end_image_url: endFrame.generatedImageUrl,
                    duration: String(seedanceSegmentSeconds),
                    resolution,
                    camera_fixed: false,
                    generate_audio: false
                };

                const response = await apiRequest('/api/video/segment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                const videoUrl = response?.videoUrl;
                if (videoUrl) {
                    segmentUrls.push(videoUrl);
                    addPathLog(`Segment ${i + 1} done!`, 'response');
                } else {
                    addPathLog(`Segment ${i + 1}: No video in response`, 'error');
                }
            } catch (err) {
                addPathLog(`Segment ${i + 1} failed: ${formatError(err)}`, 'error');
            }
        }

        if (segmentUrls.length === totalSegments) {
            const nextCache = loadAICache();
            nextCache[cacheKey] = { createdAt: Date.now(), segmentUrls };
            saveAICache(pruneAICache(nextCache));
            addPathLog('Saved AI segments to cache. Next run can skip the queue.', 'info');
        }
    }

    if (segmentUrls.length === 0) {
        showPathStatus('No segments generated', 'error');
        resetVideoUI();
        return;
    }

    pathElements.videoProgressFill.style.width = '75%';
    pathElements.videoProgressText.textContent = 'Downloading segments...';
    addPathLog(`Downloading ${segmentUrls.length} segments for stitching...`, 'info');

    try {
        const videoBlobs = [];
        for (let i = 0; i < segmentUrls.length; i++) {
            const response = await fetch(segmentUrls[i]);
            const blob = await response.blob();
            videoBlobs.push(blob);
            addPathLog(`Downloaded segment ${i + 1}`, 'info');
        }

        pathElements.videoProgressText.textContent = 'Stitching with speedup...';
        pathElements.videoProgressFill.style.width = '85%';

        const finalBlob = await stitchAndSpeedupVideos(videoBlobs, speedMultiplier, pairSeconds);

        pathState.generatedVideoBlob = finalBlob;
        pathState.generatedVideoUrl = URL.createObjectURL(finalBlob);
        pathState.generatedVideoUrlMp4 = null;
        pathState.generatedVideoBlobMp4 = null;

        pathElements.finalVideo.src = pathState.generatedVideoUrl;
        pathElements.finalVideo.classList.remove('hidden');
        pathElements.videoEmptyState.classList.add('hidden');
        pathElements.downloadVideoBtn.classList.remove('hidden');

        pathElements.videoProgressFill.style.width = '100%';
        pathElements.videoProgressText.textContent = 'Complete!';

        const finalDuration = segmentUrls.length * pairSeconds;
        showPathStatus(`Done! ${finalDuration} second video`, 'success');
        addPathLog(`Final video: ~${finalDuration} seconds (${segmentUrls.length} segments × ${pairSeconds}s)`, 'response');

        try {
            showPathStatus('Transcoding to MP4...', 'info');
            const mp4Blob = await transcodeWebmToMp4(finalBlob, 'AI');
            pathState.generatedVideoBlobMp4 = mp4Blob;
            pathState.generatedVideoUrlMp4 = URL.createObjectURL(mp4Blob);
            pathElements.finalVideo.src = pathState.generatedVideoUrlMp4;
            showPathStatus('MP4 ready!', 'success');
            addPathLog('AI: MP4 transcoding complete', 'response');
        } catch (e) {
            addPathLog(`AI: MP4 transcoding failed, keeping WebM. ${formatError(e)}`, 'warn');
        }
    } catch (err) {
        addPathLog(`Stitch error: ${formatError(err)}`, 'error');
        showPathStatus('Stitching failed - showing segments', 'warn');

        if (segmentUrls.length > 0) {
            pathState.generatedVideoUrl = segmentUrls[0];
            pathElements.finalVideo.src = segmentUrls[0];
            pathElements.finalVideo.classList.remove('hidden');
            pathElements.videoEmptyState.classList.add('hidden');
            pathElements.downloadVideoBtn.classList.remove('hidden');
        }
    }

    resetVideoUI();
}

function resetVideoUI() {
    pathState.isGeneratingVideos = false;
    pathElements.generateVideoBtn.classList.remove('generating');
    pathElements.generateVideoBtn.querySelector('.btn-text').textContent = 'Create Video';
    pathElements.generateVideoBtn.querySelector('.btn-loader').classList.add('hidden');
    updatePathButtons();
}

// Stitch video blobs with speedup using playbackRate + canvas recording.
// This avoids the “1 minute output” bug caused by slow frame pumping.
async function stitchAndSpeedupVideos(videoBlobs, speedMultiplier, targetSecondsPerSegment = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    const fps = 30;
    const stream = canvas.captureStream(fps);
    const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
        videoBitsPerSecond: 8000000
    });

    const chunks = [];
    mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const done = new Promise((resolve) => {
        mediaRecorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
    });

    mediaRecorder.start();

    // Helper: draw video to canvas with cover scaling
    function drawCover(video) {
        const vw = video.videoWidth || 1;
        const vh = video.videoHeight || 1;
        const scale = Math.max(canvas.width / vw, canvas.height / vh);
        const w = vw * scale;
        const h = vh * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, x, y, w, h);
    }

    // Play each segment at playbackRate=speedMultiplier and record while drawing.
    // IMPORTANT: record a fixed duration per segment (targetSecondsPerSegment) so slow
    // rendering/buffering can’t accidentally create a 1+ minute output.
    for (let i = 0; i < videoBlobs.length; i++) {
        addPathLog(`Stitching segment ${i + 1}/${videoBlobs.length}: ${targetSecondsPerSegment}s at ${speedMultiplier.toFixed(2)}x speed...`, 'info');

        const blobUrl = URL.createObjectURL(videoBlobs[i]);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = 'anonymous';
        video.preload = 'auto';
        video.src = blobUrl;

        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = () => reject(new Error('Failed to load video segment'));
        });

        video.playbackRate = speedMultiplier;
        // Ensure we can actually render frames (helps avoid long black starts)
        await new Promise((resolve) => {
            const done = () => resolve();
            if (video.readyState >= 2) return done();
            video.oncanplay = done;
        });

        // Start at 0
        try { video.currentTime = 0; } catch (_) {}
        await new Promise((resolve) => {
            const done = () => resolve();
            video.onseeked = done;
            // If seeked doesn’t fire (already at 0), resolve soon
            setTimeout(done, 50);
        });

        // Start playing (user gesture should allow this)
        try {
            await video.play();
        } catch (e) {
            addPathLog(`Warning: video.play() failed, stitching may be frozen. ${formatError(e)}`, 'warn');
        }

        const segmentStart = performance.now();
        let lastDraw = 0;
        await new Promise((resolve) => {
            const tick = (ts) => {
                const elapsed = ts - segmentStart;
                if (elapsed >= targetSecondsPerSegment * 1000) {
                    resolve();
                    return;
                }
                if (!lastDraw || ts - lastDraw >= 1000 / fps) {
                    drawCover(video);
                    lastDraw = ts;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });

        video.pause();
        URL.revokeObjectURL(blobUrl);
    }

    // Small tail frame so the last frame lands
    await new Promise((r) => setTimeout(r, 100));
    mediaRecorder.stop();

    return done;
}

// ===== Video Mode Toggle =====
function setupVideoModeToggle() {
    const modeBtns = document.querySelectorAll('.mode-btn');
    const quickSettings = document.getElementById('quick-settings');
    const aiSettings = document.getElementById('ai-settings');
    
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            pathState.videoMode = mode;
            
            // Update buttons
            modeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Update settings visibility
            if (mode === 'quick') {
                quickSettings.classList.remove('hidden');
                aiSettings.classList.add('hidden');
            } else {
                quickSettings.classList.add('hidden');
                aiSettings.classList.remove('hidden');
            }
        });
    });
}

// ===== Generate Video (routes to correct function) =====
function generateVideo() {
    if (pathState.videoMode === 'ai') {
        generateAIVideo();
    } else {
        generateTransitionVideo();
    }
}

// Download video
async function downloadVideo() {
    // Prefer MP4 if we have it
    if (pathState.generatedVideoBlobMp4) {
        const url = URL.createObjectURL(pathState.generatedVideoBlobMp4);
        const a = document.createElement('a');
        a.href = url;
        a.download = `camera-motion-${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        addPathLog('MP4 downloaded', 'info');
        return;
    }

    // For stitched webm (fallback)
    if (pathState.generatedVideoBlob) {
        const url = URL.createObjectURL(pathState.generatedVideoBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `camera-motion-${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        addPathLog('WebM downloaded', 'info');
        return;
    }
    
    // For AI / remote URL (fallback)
    if (pathState.generatedVideoUrlMp4) {
        window.open(pathState.generatedVideoUrlMp4, '_blank');
        return;
    }
    if (pathState.generatedVideoUrl) {
        try {
            addPathLog('Downloading video...', 'info');
            const response = await fetch(pathState.generatedVideoUrl);
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `camera-motion-${Date.now()}.mp4`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            addPathLog('Video downloaded', 'info');
        } catch (err) {
            // Fallback: open in new tab
            window.open(pathState.generatedVideoUrl, '_blank');
        }
    }
}

// ===== Setup Path Event Listeners =====
function setupPathEventListeners() {
    // Upload zone click
    
    pathElements.imageInput?.addEventListener('change', (e) => {
        if (e.target.files?.[0]) handlePathImageUpload(e.target.files[0]);
    });
    
    // Drag and drop
    pathElements.uploadZone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        pathElements.uploadZone.classList.add('drag-over');
    });
    
    pathElements.uploadZone?.addEventListener('dragleave', () => {
        pathElements.uploadZone.classList.remove('drag-over');
    });
    
    pathElements.uploadZone?.addEventListener('drop', (e) => {
        e.preventDefault();
        pathElements.uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files?.[0]) handlePathImageUpload(e.dataTransfer.files[0]);
    });
    
    // Clear image
    pathElements.clearImage?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearPathImage();
    });
    
    // URL input
    pathElements.loadUrlBtn?.addEventListener('click', () => {
        loadPathImageFromUrl(pathElements.imageUrlInput.value);
    });
    
    pathElements.imageUrlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadPathImageFromUrl(pathElements.imageUrlInput.value);
    });
    
    // Clear waypoints
    pathElements.clearWaypointsBtn?.addEventListener('click', () => {
        pathState.waypoints = [];
        if (pathThreeScene) pathThreeScene.updateWaypoints();
        updateWaypointsList();
        updatePathButtons();
        updateGallery();
        addPathLog('Cleared all waypoints', 'info');
    });
    
    // Undo waypoint
    pathElements.undoWaypointBtn?.addEventListener('click', () => {
        if (pathState.waypoints.length > 0) {
            pathState.waypoints.pop();
            if (pathThreeScene) pathThreeScene.updateWaypoints();
            updateWaypointsList();
            updatePathButtons();
            addPathLog('Removed last waypoint', 'info');
        }
    });
    
    // Generate keyframes
    pathElements.generateKeyframesBtn?.addEventListener('click', generateKeyframes);
    
    // Download all
    pathElements.downloadAllBtn?.addEventListener('click', downloadAllAsZip);
    
    // Generate video
    pathElements.generateVideoBtn?.addEventListener('click', generateVideo);
    
    // Setup video mode toggle
    setupVideoModeToggle();
    
    // Download video
    pathElements.downloadVideoBtn?.addEventListener('click', downloadVideo);
    
    // Clear logs
    pathElements.clearLogsBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pathElements.logsContainer) {
            pathElements.logsContainer.innerHTML = '<div class="log-entry info">Logs cleared.</div>';
        }
    });
    
}

// ===== Initialize =====
function init() {
    // Cache DOM elements - Single Angle Tab
    elements.uploadZone = document.getElementById('upload-zone');
    elements.imageInput = document.getElementById('image-input');
    elements.uploadPlaceholder = document.getElementById('upload-placeholder');
    elements.previewImage = document.getElementById('preview-image');
    elements.clearImage = document.getElementById('clear-image');
    elements.imageUrlInput = document.getElementById('image-url-input');
    elements.loadUrlBtn = document.getElementById('load-url-btn');
    elements.threejsContainer = document.getElementById('threejs-container');
    elements.azimuthSlider = document.getElementById('azimuth-slider');
    elements.elevationSlider = document.getElementById('elevation-slider');
    elements.distanceSlider = document.getElementById('distance-slider');
    elements.azimuthValue = document.getElementById('azimuth-value');
    elements.elevationValue = document.getElementById('elevation-value');
    elements.distanceValue = document.getElementById('distance-value');
    elements.promptDisplay = document.getElementById('prompt-display');
    elements.generateBtn = document.getElementById('generate-btn');
    elements.outputContainer = document.getElementById('output-container');
    elements.outputPlaceholder = document.getElementById('output-placeholder');
    elements.outputImage = document.getElementById('output-image');
    elements.downloadBtn = document.getElementById('download-btn');
    elements.statusMessage = document.getElementById('status-message');
    elements.logsContainer = document.getElementById('logs-container');
    elements.clearLogs = document.getElementById('clear-logs');

    // Cache DOM elements - Camera Path Tab
    pathElements.uploadZone = document.getElementById('path-upload-zone');
    pathElements.imageInput = document.getElementById('path-image-input');
    pathElements.uploadPlaceholder = document.getElementById('path-upload-placeholder');
    pathElements.previewImage = document.getElementById('path-preview-image');
    pathElements.clearImage = document.getElementById('path-clear-image');
    pathElements.imageUrlInput = document.getElementById('path-image-url-input');
    pathElements.loadUrlBtn = document.getElementById('path-load-url-btn');
    pathElements.threejsContainer = document.getElementById('path-threejs-container');
    pathElements.clearWaypointsBtn = document.getElementById('clear-waypoints-btn');
    pathElements.undoWaypointBtn = document.getElementById('undo-waypoint-btn');
    pathElements.placementZoomLabel = document.getElementById('placement-zoom-label');
    pathElements.waypointsList = document.getElementById('waypoints-list');
    pathElements.waypointCount = document.getElementById('waypoint-count');
    pathElements.generateKeyframesBtn = document.getElementById('generate-keyframes-btn');
    pathElements.keyframeProgress = document.getElementById('keyframe-progress');
    pathElements.keyframeProgressFill = document.getElementById('keyframe-progress-fill');
    pathElements.keyframeProgressText = document.getElementById('keyframe-progress-text');
    pathElements.gallery = document.getElementById('keyframes-gallery');
    pathElements.downloadAllBtn = document.getElementById('download-all-btn');
    pathElements.videoDuration = document.getElementById('video-duration');
    pathElements.transitionStyle = document.getElementById('transition-style');
    pathElements.videoFps = document.getElementById('video-fps');
    pathElements.easeType = document.getElementById('ease-type');
    pathElements.generateVideoBtn = document.getElementById('generate-video-btn');
    pathElements.videoProgress = document.getElementById('video-progress');
    pathElements.videoProgressFill = document.getElementById('video-progress-fill');
    pathElements.videoProgressText = document.getElementById('video-progress-text');
    pathElements.videoCanvas = document.getElementById('video-canvas');
    pathElements.finalVideo = document.getElementById('final-video');
    pathElements.videoEmptyState = document.getElementById('video-empty-state');
    pathElements.downloadVideoBtn = document.getElementById('download-video-btn');
    pathElements.aiPrompt = document.getElementById('ai-prompt');
    pathElements.aiDuration = document.getElementById('ai-duration');
    pathElements.aiResolution = document.getElementById('ai-resolution');
    pathElements.aiPairSeconds = document.getElementById('ai-pair-seconds');
    pathElements.aiLoopPath = document.getElementById('ai-loop-path');
    pathElements.aiVideoModel = document.getElementById('ai-video-model');
    pathElements.statusMessage = document.getElementById('path-status-message');
    pathElements.logsContainer = document.getElementById('path-logs-container');
    pathElements.clearLogsBtn = document.getElementById('path-clear-logs');

    // Cache DOM elements - Next Scene Tab
    nextSceneElements.uploadZone = document.getElementById('next-scene-upload-zone');
    nextSceneElements.imageInput = document.getElementById('next-scene-image-input');
    nextSceneElements.uploadPlaceholder = document.getElementById('next-scene-upload-placeholder');
    nextSceneElements.previewImage = document.getElementById('next-scene-preview-image');
    nextSceneElements.clearImage = document.getElementById('next-scene-clear-image');
    nextSceneElements.imageUrlInput = document.getElementById('next-scene-image-url-input');
    nextSceneElements.loadUrlBtn = document.getElementById('next-scene-load-url-btn');
    nextSceneElements.prompt = document.getElementById('next-scene-prompt');
    nextSceneElements.loraScale = document.getElementById('next-scene-lora-scale');
    nextSceneElements.generateBtn = document.getElementById('next-scene-generate-btn');
    nextSceneElements.outputContainer = document.getElementById('next-scene-output-container');
    nextSceneElements.outputPlaceholder = document.getElementById('next-scene-output-placeholder');
    nextSceneElements.outputImage = document.getElementById('next-scene-output-image');
    nextSceneElements.downloadBtn = document.getElementById('next-scene-download-btn');
    nextSceneElements.statusMessage = document.getElementById('next-scene-status-message');
    nextSceneElements.logsContainer = document.getElementById('next-scene-logs-container');
    nextSceneElements.clearLogsBtn = document.getElementById('next-scene-clear-logs');

    // Cache DOM elements - Light Transfer Tab
    lightTransferElements.sourceUploadZone = document.getElementById('light-transfer-source-upload-zone');
    lightTransferElements.sourceImageInput = document.getElementById('light-transfer-source-image-input');
    lightTransferElements.sourceUploadPlaceholder = document.getElementById('light-transfer-source-upload-placeholder');
    lightTransferElements.sourcePreviewImage = document.getElementById('light-transfer-source-preview-image');
    lightTransferElements.sourceClearImage = document.getElementById('light-transfer-source-clear-image');
    lightTransferElements.sourceImageUrlInput = document.getElementById('light-transfer-source-image-url-input');
    lightTransferElements.sourceLoadUrlBtn = document.getElementById('light-transfer-source-load-url-btn');
    lightTransferElements.referenceUploadZone = document.getElementById('light-transfer-reference-upload-zone');
    lightTransferElements.referenceImageInput = document.getElementById('light-transfer-reference-image-input');
    lightTransferElements.referenceUploadPlaceholder = document.getElementById('light-transfer-reference-upload-placeholder');
    lightTransferElements.referencePreviewImage = document.getElementById('light-transfer-reference-preview-image');
    lightTransferElements.referenceClearImage = document.getElementById('light-transfer-reference-clear-image');
    lightTransferElements.referenceImageUrlInput = document.getElementById('light-transfer-reference-image-url-input');
    lightTransferElements.referenceLoadUrlBtn = document.getElementById('light-transfer-reference-load-url-btn');
    lightTransferElements.loraScale = document.getElementById('light-transfer-lora-scale');
    lightTransferElements.generateBtn = document.getElementById('light-transfer-generate-btn');
    lightTransferElements.outputContainer = document.getElementById('light-transfer-output-container');
    lightTransferElements.outputPlaceholder = document.getElementById('light-transfer-output-placeholder');
    lightTransferElements.outputImage = document.getElementById('light-transfer-output-image');
    lightTransferElements.downloadBtn = document.getElementById('light-transfer-download-btn');
    lightTransferElements.statusMessage = document.getElementById('light-transfer-status-message');
    lightTransferElements.logsContainer = document.getElementById('light-transfer-logs-container');
    lightTransferElements.clearLogsBtn = document.getElementById('light-transfer-clear-logs');

    // Cache DOM elements - Gaussian Splash Tab
    gaussianSplashElements.uploadZone = document.getElementById('gaussian-splash-upload-zone');
    gaussianSplashElements.imageInput = document.getElementById('gaussian-splash-image-input');
    gaussianSplashElements.uploadPlaceholder = document.getElementById('gaussian-splash-upload-placeholder');
    gaussianSplashElements.previewImage = document.getElementById('gaussian-splash-preview-image');
    gaussianSplashElements.clearImage = document.getElementById('gaussian-splash-clear-image');
    gaussianSplashElements.imageUrlInput = document.getElementById('gaussian-splash-image-url-input');
    gaussianSplashElements.loadUrlBtn = document.getElementById('gaussian-splash-load-url-btn');
    gaussianSplashElements.loraScale = document.getElementById('gaussian-splash-lora-scale');
    gaussianSplashElements.generateBtn = document.getElementById('gaussian-splash-generate-btn');
    gaussianSplashElements.outputContainer = document.getElementById('gaussian-splash-output-container');
    gaussianSplashElements.outputPlaceholder = document.getElementById('gaussian-splash-output-placeholder');
    gaussianSplashElements.outputImage = document.getElementById('gaussian-splash-output-image');
    gaussianSplashElements.downloadBtn = document.getElementById('gaussian-splash-download-btn');
    gaussianSplashElements.statusMessage = document.getElementById('gaussian-splash-status-message');
    gaussianSplashElements.logsContainer = document.getElementById('gaussian-splash-logs-container');
    gaussianSplashElements.clearLogsBtn = document.getElementById('gaussian-splash-clear-logs');

    // Initialize Single Angle
    setupEventListeners();
    initThreeJS();
    updateSliderValues();
    updatePromptDisplay();
    updateGenerateButton();

    // Initialize Tab Switching
    setupTabSwitching();

    // Initialize Camera Path
    setupPathEventListeners();
    updateWaypointsList();
    updatePathButtons();
    updateGallery();

    // Initialize Next Scene
    setupNextSceneEventListeners();
    updateNextSceneButton();

    // Initialize Light Transfer
    setupLightTransferEventListeners();
    updateLightTransferButton();

    // Initialize Gaussian Splash
    setupGaussianSplashEventListeners();
    updateGaussianSplashButton();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

