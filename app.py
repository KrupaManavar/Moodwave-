import os
from dotenv import load_dotenv
load_dotenv()

import time
import base64
import threading
from io import BytesIO

from flask import Flask, request, jsonify, render_template
from ytmusicapi import YTMusic


app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev_secret_change_me")

# ── Initialise YTMusic (no auth needed for search) ─────────────────────────
ytmusic = YTMusic()

# ── FER detector – initialised once at startup in a background thread ───────
_fer_detector = None
_fer_ready = threading.Event()

def _init_fer():
    global _fer_detector
    try:
        from fer import FER  # type: ignore
        print("[MoodWave] Loading FER / TensorFlow model – please wait…")
        _fer_detector = FER(mtcnn=True)
        print("[MoodWave] FER detector ready ✓")
    except Exception as e:
        print(f"[MoodWave] FER not available ({e}). Mood detection will return 'neutral'.")
    finally:
        _fer_ready.set()

threading.Thread(target=_init_fer, daemon=True).start()

MOOD_TO_QUERY = {
    "happy":   "happy upbeat Hindi and English pop music",
    "sad":     "sad emotional Hindi and English music",
    "angry":   "intense angry Hindi and English rock music",
    "relaxed": "chill relaxing Hindi and English lofi music",
    "neutral": "popular Hindi and English music mix",
    "fear":    "ambient atmospheric Hindi and English music",
    "disgust": "alternative indie Hindi and English music",
    "surprise":"feel good energetic Hindi and English music",
    "romantic":"romantic Hindi and English love songs",
    "energetic":"upbeat Hindi and English gym workout music",
    "focus":   "focus concentration study Hindi and English music",
    "sleeping":"lullaby lori hindi english gujarati sleep music",
}


def detect_mood_from_image(image_bytes):
    """
    Detect mood from an image using FER.
    Waits up to 60 s for the model to initialise on first call.
    """
    _fer_ready.wait(timeout=60)  # wait for the background loader

    if _fer_detector is None:
        return "neutral", {}

    try:
        from PIL import Image   
        import numpy as np      
        image = Image.open(BytesIO(image_bytes)).convert("RGB")
        np_img = np.array(image)
    except Exception:
        return "neutral", {}

    try:
        results = _fer_detector.detect_emotions(np_img)
    except Exception:
        return "neutral", {}

    if not results:
        return "neutral", {}

    best = max(results, key=lambda r: sum(r.get("emotions", {}).values()))
    emotions = best.get("emotions", {})
    if not emotions:
        return "neutral", {}

    mood = max(emotions, key=emotions.get)
    return mood, emotions


@app.route("/fer_status")
def fer_status():
    """Returns whether the FER model is loaded yet."""
    ready = _fer_ready.is_set()
    return jsonify({"ready": ready, "has_detector": _fer_detector is not None})


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/detect_mood", methods=["POST"])
def detect_mood():
    """
    Accepts JSON with { image: "data:image/jpeg;base64,..." }
    Returns detected mood and emotion scores.
    """
    body = request.get_json(silent=True) or {}
    image_data = body.get("image", "")
    if not image_data:
        return jsonify({"error": "Missing image"}), 400

    if "," in image_data:
        image_data = image_data.split(",", 1)[1]

    try:
        image_bytes = base64.b64decode(image_data)
    except Exception:
        return jsonify({"error": "Invalid image data"}), 400

    mood, emotions = detect_mood_from_image(image_bytes)
    return jsonify({"mood": mood, "emotions": emotions})


@app.route("/recommend")
def recommend():
    mood = request.args.get("mood") or "neutral"
    seed_genres = request.args.get("seed_genres", "").strip()
    limit = int(request.args.get("limit", 20))

    # Build search query
    base_query = MOOD_TO_QUERY.get(mood, MOOD_TO_QUERY["neutral"])
    if seed_genres:
        query = f"{seed_genres} {base_query}"
    else:
        query = base_query

    try:
        results = ytmusic.search(query, filter="songs", limit=limit)
    except Exception as e:
        return jsonify({"error": "YouTube Music search failed", "details": str(e)}), 500

    tracks = []
    for item in results[:limit]:
        video_id = item.get("videoId")
        if not video_id:
            continue

        # Thumbnail - pick the largest available
        thumbnails = item.get("thumbnails", [])
        thumb = thumbnails[-1]["url"] if thumbnails else ""

        # Artists
        artists_raw = item.get("artists") or []
        artists_str = ", ".join(a.get("name", "") for a in artists_raw if a.get("name"))

        # Album
        album_raw = item.get("album") or {}
        album_name = album_raw.get("name", "") if isinstance(album_raw, dict) else ""

        tracks.append({
            "id": video_id,
            "name": item.get("title", "Unknown"),
            "artists": artists_str or "Unknown Artist",
            "album": album_name,
            "image": thumb,
            "duration": item.get("duration", ""),
        })

    return jsonify({"mood": mood, "tracks": tracks})


if __name__ == "__main__":
    # use_reloader=False prevents the watchdog from restarting the server
    # every time TensorFlow / FER loads its modules, which caused connection resets.
    app.run(debug=True, use_reloader=False, threaded=True)
