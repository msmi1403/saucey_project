#!/usr/bin/env python3
import base64
import json
import urllib.request
import sys

# —— CONFIGURE THESE —— 
ENDPOINT = "https://handle-recipe-chat-turn-7jk5zwwfwq-uc.a.run.app"
IMAGE    = "IMG_4520.jpg"
# ——————————————

def build_payload(image_path):
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    return {
        "userId": "malcolm-test-image",
        "imageDataB64": b64,
        "imageInstructions": "Extract ingredients and simplify the steps."
    }

def main():
    try:
        payload = build_payload(IMAGE)
    except FileNotFoundError:
        print(f"ERROR: could not find {IMAGE}", file=sys.stderr)
        sys.exit(1)

    json_data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, 
        data=json_data, 
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            print("STATUS:", resp.status)
            print("RESPONSE:", body)
    except urllib.error.HTTPError as e:
        print("HTTP ERROR:", e.code, e.reason, file=sys.stderr)
        print(e.read().decode(), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print("REQUEST FAILED:", e, file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
