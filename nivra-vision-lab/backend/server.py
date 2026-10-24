"""Loopback-only inference service; receives one bounded RGB filmstrip per request."""
from __future__ import annotations

import asyncio
import io
import logging
import os
import threading
from contextlib import asynccontextmanager

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from PIL import Image, UnidentifiedImageError

from detector import FightEnsemble, FRAMES, MODEL_REVISION, SIZE, THRESHOLD
from guards import GUARD_PORT, lan_app, owner as guard_owner
from incidents import router as incident_router
from policy import ENGINE_VERSION, THRESHOLDS
from usb_phone import AppNotOpen, PhoneUnplugged, UsbPhone, VideoUnsupported

detector: FightEnsemble | None = None
load_error: str | None = None
inference_lock = asyncio.Lock()
MAX_BYTES = 2_000_000


usb_phone = UsbPhone()
usb_lock = asyncio.Lock()


async def serve_guard_phones():
    # Separate listener so Wi-Fi clients never reach the loopback inference API.
    server = uvicorn.Server(uvicorn.Config(lan_app, host="0.0.0.0", port=GUARD_PORT, log_level="warning", access_log=False))
    server.install_signal_handlers = lambda: None
    try:
        await server.serve()
    except (OSError, SystemExit):
        logging.exception("Guard phone listener could not start on port %s", GUARD_PORT)
    return server


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global detector, load_error
    guard_task = asyncio.create_task(serve_guard_phones())
    # Plug-in-and-go: watch the USB cable and open NIVRA on a plugged-in iPhone.
    usb_stop = threading.Event()
    threading.Thread(target=usb_phone.auto_loop, args=(usb_stop,), name="usb-auto", daemon=True).start()
    try:
        detector = await asyncio.to_thread(FightEnsemble, os.environ.get("NIVRA_DEVICE", "cpu"))
    except Exception as exc:
        load_error = str(exc)
        logging.exception("Fight model failed to load")
    yield
    usb_stop.set()
    guard_task.cancel()


app = FastAPI(title="NIVRA local fight inference", lifespan=lifespan)
app.include_router(guard_owner)
app.include_router(incident_router)


@app.get("/usb/devices")
async def usb_devices():
    try:
        return await asyncio.to_thread(usb_phone.status)
    except OSError as exc:
        raise HTTPException(503, "Could not read USB devices on this Mac.") from exc


@app.post("/usb/connect")
async def usb_connect(request: Request):
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError
        return await asyncio.to_thread(usb_phone.connect, str(body.get("deviceId", "")), str(body.get("code", "")))
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc) or "Enter the eight-character code shown on the phone.") from exc
    except (ConnectionError, OSError) as exc:
        raise HTTPException(503, str(exc) if isinstance(exc, ConnectionError) else "Open NIVRA on the phone and start its camera.") from exc


@app.put("/usb/auto")
async def usb_auto(request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = {}
    return {"enabled": usb_phone.set_auto(bool(body.get("enabled", True)) if isinstance(body, dict) else True)}


@app.delete("/usb/connect", status_code=204)
async def usb_disconnect():
    usb_phone.disconnect()


usb_video_lock = asyncio.Lock()


def _usb_wait_message(exc: BaseException) -> str:
    # Plain reasons from the phone client (app closed, cable out) are shown to the operator as is.
    if isinstance(exc, (AppNotOpen, PhoneUnplugged)) and str(exc):
        return str(exc)
    return "Waiting for the phone camera. Keep NIVRA open on the phone."


@app.get("/usb/video")
async def usb_video(after: int | None = None):
    # Compressed H.264 at the phone camera's full frame rate (30-40 fps), decoded in the browser.
    if usb_video_lock.locked():
        raise HTTPException(429, "Video request already running")
    async with usb_video_lock:
        try:
            body = await asyncio.wait_for(asyncio.to_thread(usb_phone.video, after), 4)
        except LookupError as exc:
            raise HTTPException(409, str(exc)) from exc
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except VideoUnsupported as exc:
            raise HTTPException(501, str(exc)) from exc
        except (asyncio.TimeoutError, ConnectionError, OSError) as exc:
            raise HTTPException(503, _usb_wait_message(exc)) from exc
    if not body:
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    return Response(body, media_type="application/json", headers={"Cache-Control": "no-store"})


@app.get("/usb/frame")
async def usb_frame():
    # One pull at a time keeps usbmuxd from queueing stale frames.
    if usb_lock.locked():
        raise HTTPException(429, "Frame request already running")
    async with usb_lock:
        try:
            headers, body = await asyncio.wait_for(asyncio.to_thread(usb_phone.frame), 4)
        except LookupError as exc:
            raise HTTPException(409, str(exc)) from exc
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except (asyncio.TimeoutError, ConnectionError, OSError) as exc:
            raise HTTPException(503, _usb_wait_message(exc)) from exc
    passthrough = {key: headers[name] for key, name in (("X-Nivra-Sequence", "x-nivra-sequence"), ("X-Nivra-Timestamp", "x-nivra-timestamp")) if name in headers}
    return Response(body, media_type="image/jpeg", headers={"Cache-Control": "no-store", **passthrough})


@app.get("/health")
def health():
    return {"ready": detector is not None, "error": load_error,
            "model": "X3D-M + ViT consensus", "revision": MODEL_REVISION, "engine": ENGINE_VERSION,
            "device": str(detector.device) if detector else None,
            "sha256": detector.sha256 if detector else None,
            "frames": FRAMES, "threshold": THRESHOLD, "thresholds": THRESHOLDS, "requiredVotes": 2}


@app.post("/predict")
async def predict(request: Request):
    if detector is None:
        raise HTTPException(503, load_error or "Model is loading")
    if inference_lock.locked():
        raise HTTPException(429, "Analysis is busy; send a fresh window later")
    # Avoid accumulating stale windows from multiple tabs or oversized bodies.
    async with inference_lock:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BYTES:
                raise HTTPException(413, "Filmstrip is too large")
        try:
            image = Image.open(io.BytesIO(body))
            if image.size != (SIZE * FRAMES, SIZE):
                raise ValueError("Unexpected filmstrip dimensions")
            strip = np.asarray(image.convert("RGB"))
            frames = np.stack(np.split(strip, FRAMES, axis=1))
        except (ValueError, UnidentifiedImageError, OSError) as exc:
            raise HTTPException(422, "Invalid RGB filmstrip") from exc
        return await asyncio.to_thread(detector.predict, frames)
