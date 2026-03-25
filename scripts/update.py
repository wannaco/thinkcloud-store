#!/usr/bin/env python3
import json
import os
import subprocess
import re
import requests
from pathlib import Path
import time

# Add your Google Chat Webhook URL here
WEBHOOK_URL = os.environ.get("GOOGLE_CHAT_WEBHOOK_URL", "")

def send_notification(message):
    if not WEBHOOK_URL:
        return
    try:
        requests.post(WEBHOOK_URL, json={"text": message})
    except Exception as e:
        print(f"Failed to send notification: {e}")

def get_latest_release(repo):
    try:
        cmd = ["gh", "api", f"repos/{repo}/releases/latest", "--jq", ".tag_name"]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except Exception as e:
        print(f"Failed to get release for {repo}: {e}")
        return None

def update_app(app_path):
    config_file = app_path / "config.json"
    compose_file = app_path / "docker-compose.json"
    
    if not config_file.exists() or not compose_file.exists():
        return

    with open(config_file, "r") as f:
        config = json.load(f)

    source_url = config.get("source", "")
    if "github.com" not in source_url:
        return

    repo = source_url.replace("https://github.com/", "").strip("/")
    latest_version = get_latest_release(repo)

    if not latest_version or latest_version == config.get("version"):
        # print(f"{app_path.name}: Up to date ({config.get('version')})")
        return

    msg = f"🚀 *{app_path.name}*: Updating {config.get('version')} -> {latest_version}"
    print(msg)
    
    # Update config.json
    config["version"] = latest_version
    config["updated_at"] = int(time.time() * 1000)
    with open(config_file, "w") as f:
        json.dump(config, f, indent=2)

    # Update docker-compose.json
    with open(compose_file, "r") as f:
        compose_content = f.read()
    
    new_compose = re.sub(r'(image": ".*):([^"]+)', rf'\1{latest_version}', compose_content)
    
    with open(compose_file, "w") as f:
        f.write(new_compose)

    send_notification(msg)

def run():
    apps_dir = Path("/root/.openclaw/workspace/thinkcloud-store/apps")
    for app_path in apps_dir.iterdir():
        if app_path.is_dir():
            update_app(app_path)

if __name__ == "__main__":
    run()
