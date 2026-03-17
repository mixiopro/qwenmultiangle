# Mixio Multi-Angle Camera Control

A small web app that lets you adjust a virtual camera (azimuth, elevation, zoom), generate alternate views of an image using Mixio’s multi-angle workflow, and create follow-up frames with the new Next-Scene image-edit flow.

## Screenshot

![Qwen Multi-Angle App](qwenmultiangle.png)

## Features

- Interactive Three.js camera controls (drag handles + sliders)
- Works with an uploaded image or an image URL
- Multi-image keyframes + camera motion (image-to-video) mode
- Next-Scene tab for generating a follow-up scene from a source image
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
