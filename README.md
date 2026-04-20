# Mixio Multi-Angle Camera Control

A small web app that lets you adjust a virtual camera (azimuth, elevation, zoom), generate alternate views of an image using Mixio’s multi-angle workflow, and create follow-up frames with the new Next-Scene image-edit flow.

## Screenshot

![Qwen Multi-Angle App](qwenmultiangle.png)

## Features

- Interactive Three.js camera controls (drag handles + sliders)
- Works with an uploaded image or an image URL
- Multi-image keyframes + camera motion (image-to-video) mode
- Next-Scene tab for generating a follow-up scene from a source image
- Light-Transfer tab for relighting a source image using a lighting reference image
- Backend-managed API access using environment configuration

## Credits & Inspiration

Inspired by [multimodalart/qwen-image-multiple-angles-3d-camera](https://huggingface.co/spaces/multimodalart/qwen-image-multiple-angles-3d-camera) on Hugging Face Spaces.

Powered by Mixio

## Getting Started

### Prerequisites

- Node.js 18+
- A backend environment variable: `FAL_API_KEY`

### Local Development

```bash
npm install
npm start
```

Then open `http://localhost:3000`. The app uses the backend `FAL_API_KEY` environment variable; no API key is entered in the UI.

## Next-Scene Workflow

The app includes a dedicated **Next-Scene** tab powered by fal's `fal-ai/qwen-image-edit-plus-lora-gallery/next-scene` model.

- Start from an uploaded image or an image URL
- Enter a scene-change prompt describing camera or scene evolution
- Prompts are normalized server-side to always begin with `Next Scene:`
- LoRA strength is exposed in the UI with a recommended range of `0.7–0.8` and a default of `0.75`

Example prompt:

```text
The camera pulls back to reveal a wider view of the city as neon reflections flicker across the wet street.
```

The backend sends this as:

```text
Next Scene: The camera pulls back to reveal a wider view of the city as neon reflections flicker across the wet street.
```

## Light-Transfer Workflow

The app includes a dedicated **Light-Transfer** tab powered by fal's `fal-ai/qwen-image-edit-2509-lora` model.

- Input 1 (`image_urls[0]`): source image to be relit
- Input 2 (`image_urls[1]`): lighting reference image
- Output size is sent as `image_size` from the source image, matching the Gradio demo’s max-edge-1024, aspect-ratio-preserving behavior
- Fixed prompt is applied server-side:

```text
参考色调，移除图1原有的光照并参考图2的光照和色调对图1重新照明
```

- LoRA is passed via `loras: [{ path, scale }]`
- Default LoRA path points to the Hugging Face safetensors file in this repo:
  - `https://huggingface.co/dx8152/Qwen-Edit-2509-Light-Migration/resolve/main/%E5%8F%82%E8%80%83%E8%89%B2%E8%B0%83.safetensors`
- Override LoRA path with backend env var:
  - `QWEN_LIGHT_TRANSFER_LORA_PATH`

## Relight Workflow

The app includes a dedicated **Relight** tab powered by fal's `fal-ai/qwen-image-edit-2509-lora` model.

- Input 1 (`image_urls[0]`): source image to relight
- Input 2: the user's English or Chinese lighting instruction
- The backend rewrites the instruction with `gemini-3.1-flash-lite-preview` into a short Chinese prompt that stays close to the user's intent and does not add extra details
- The wording style stays close to the README example, for example:

```text
使用窗帘透光（柔和漫射）的光线对图片进行重新照明
```

- Fixed trigger token is always `重新照明` and the final prompt is sent as:

```text
重新照明,<short Chinese instruction>
```

- Export `GEMINI_API_KEY` on the remote instance for the prompt enhancer to work. The relight enhancer does not ship with a fallback key.
- LoRA is passed via `loras: [{ path, scale }]`
- Default LoRA path points to:
  - `https://huggingface.co/dx8152/Qwen-Image-Edit-2509-Relight/resolve/main/Qwen-Edit-Relight.safetensors`
- Override LoRA path with backend env var:
  - `QWEN_RELIGHT_LORA_PATH`

## Project Structure

```
qwenmultiangle/
├── index.html      # Main HTML structure
├── style.css       # Modern dark theme styling
├── app.js          # Three.js scene + frontend app logic
├── server.js       # Express server + backend API proxy
├── package.json    # Node.js dependencies
└── README.md       # This file
```

## Camera Controls

| Control | Range | Description |
|---------|-------|-------------|
| **Azimuth** (`horizontal_angle`) | 0° - 360° | Horizontal rotation (front/right/back/left) |
| **Elevation** (`vertical_angle`) | -30° - 90° | Vertical angle (low → bird’s-eye) |
| **Zoom** (`zoom`) | 0 - 10 | Wide → close-up |

## License

MIT
