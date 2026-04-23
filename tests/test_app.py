import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import app as app_module


def test_login_rejects_placeholder_credentials():
    client = app_module.app.test_client()
    app_module.CLIENT_ID = "your_client_id"
    app_module.CLIENT_SECRET = "your_client_secret"

    resp = client.get("/login")
    assert resp.status_code == 400
    data = resp.get_json()
    assert "SPOTIFY_CLIENT_ID" in data["error"]


def test_recommend_requires_auth():
    client = app_module.app.test_client()

    resp = client.get(
        "/recommend?mood=neutral&seed_genres=pop&limit=5",
        headers={"Accept": "application/json"},
    )
    assert resp.status_code == 401
