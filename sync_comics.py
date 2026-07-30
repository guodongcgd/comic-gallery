#!/usr/bin/env python3
"""
Sync new comics from api-comic.labs.gay to Cloudflare D1 database.
Fetches new comics, posts them to /api/comics (D1-backed endpoint).
No more comics.json file updates needed.
"""
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

API_BROWSE = "https://api-comic.labs.gay/api/browse?indexUid=gaylabs"
GALLERY_API = "https://comic-gallery.pages.dev/api/comics"
REPO_DIR = Path("/home/agentuser/comic-gallery")
JSON_PATH = "comics.json"  # local fallback
GIT_TOKEN_FILE = Path("/home/agentuser/.hermes/.github_token")


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def parse_date_ts(date_str):
    """Parse date string to timestamp."""
    date_str = date_str.strip()
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"]:
        try:
            dt = datetime.strptime(date_str, fmt)
            return int(dt.timestamp())
        except ValueError:
            continue
    return 0


def get_latest_date_from_d1():
    """Get the latest published_at from D1 via API."""
    try:
        # Use stats endpoint to find latest date
        # Actually, let's fetch the first page (sorted by id DESC) to get the latest
        resp = httpx.get(f"{GALLERY_API}?page=1&size=1", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        comics = data.get("comics", [])
        if comics:
            return comics[0].get("published_at", "2020-01-01 00:00")
        return "2020-01-01 00:00"
    except Exception as e:
        log(f"Error getting latest date from D1: {e}")
        # Fallback: check local comics.json
        local_path = REPO_DIR / JSON_PATH
        if local_path.exists():
            with open(local_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            dates = [c.get("published_at", "").strip() for c in data.get("comics", []) if c.get("published_at")]
            dates.sort(reverse=True)
            return dates[0] if dates else "2020-01-01 00:00"
        return "2020-01-01 00:00"


def extract_author(title_jp):
    m = re.match(r'^\[([^\]]+)\]', title_jp)
    return m.group(1).strip() if m else ""


def extract_tags(category_path_zh):
    tags = []
    for path in category_path_zh:
        parts = path.split("> ")
        if len(parts) >= 2:
            tag = parts[-1].strip()
            if tag and tag not in tags:
                tags.append(tag)
    return tags


def extract_title_cn(title_jp, title_en):
    # Try separator
    for sep in ["︱", "|", "｜"]:
        if sep in title_jp:
            after = title_jp.split(sep, 1)[1]
            after = re.sub(r'\[.*?\]', '', after).strip()
            if after:
                return after
    for sep in ["︱", "|", "｜"]:
        if sep in title_en:
            after = title_en.split(sep, 1)[1]
            after = re.sub(r'\[.*?\]', '', after).strip()
            if after:
                return after
    title = title_en
    title = re.sub(r'^\[[^\]]*\]\s*', '', title)
    title = re.sub(r'\s*\[.*?\]', '', title).strip()
    if title:
        return title
    return title_jp[:60] if len(title_jp) > 60 else title_jp


def extract_title_original(title_jp):
    return re.sub(r'\s*\[[^\]]*\]\s*$', '', title_jp.strip())


def fetch_all_new_comics(latest_date_ts, limit=200):
    """Fetch all comics newer than latest_date_ts."""
    new_comics = []
    page = 1
    hits_per_page = 200

    while True:
        url = f"{API_BROWSE}&query=&page={page}&hitsPerPage={hits_per_page}&includeFacets=false"
        log(f"Fetching page {page}...")

        try:
            resp = httpx.get(url, timeout=30)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            log(f"Error fetching page {page}: {e}")
            break

        hits = data.get("hits", [])
        if not hits:
            break

        for hit in hits:
            ts = hit.get("postedTimestamp", 0)
            if ts > latest_date_ts:
                new_comics.append(hit)

        total_pages = data.get("totalPages", 1)
        log(f"  Got {len(hits)} hits, {len(new_comics)} new so far (page {page}/{total_pages})")

        if page >= total_pages:
            break
        if hits and hits[-1].get("postedTimestamp", 0) <= latest_date_ts:
            log(f"  Reached cutoff at page {page}, stopping")
            break

        page += 1
        time.sleep(0.5)
        if len(new_comics) >= limit:
            log(f"  Reached limit of {limit}")
            break

    new_comics.sort(key=lambda x: x.get("postedTimestamp", 0))
    return new_comics


def get_next_id():
    """Get the next available ID from D1 (uses max id directly)."""
    try:
        # Use stats endpoint to get max_id from D1 directly
        resp = httpx.get(f"{GALLERY_API}?page=1&size=20000", timeout=30)
        resp.raise_for_status()
        data = resp.json()
        comics = data.get("comics", [])
        if comics:
            max_id = max(int(c["id"]) for c in comics)
            return max_id + 1
        return 1
    except Exception as e:
        log(f"Warning: could not get next_id from API: {e}")
        return 1


def map_to_gallery_format(api_comics, next_id):
    gallery_comics = []
    for ac in api_comics:
        title_jp = ac.get("title_jp", "")
        title_en = ac.get("title", "")
        gallery_comics.append({
            "id": next_id,
            "title_cn": extract_title_cn(title_jp, title_en),
            "title_original": extract_title_original(title_jp),
            "cover_url": ac.get("thumb_url", ""),
            "author": extract_author(title_jp),
            "tags": extract_tags(ac.get("category_path_zh", [])),
            "telegraph_url": ac.get("telegraph_url", ""),
            "telegram_url": ac.get("message_url", ""),
            "published_at": ac.get("posted", "").strip(),
            "pages": ac.get("pages", 0),
            "stars": ac.get("favorite", 0),
        })
        next_id += 1
    return gallery_comics


def post_to_d1(comics):
    """POST new comics to D1-backed API in batches."""
    batch_size = 50
    total = len(comics)
    added = 0
    skipped = 0

    for i in range(0, total, batch_size):
        batch = comics[i:i + batch_size]
        try:
            resp = httpx.post(
                GALLERY_API,
                json={"comics": batch},
                timeout=60,
            )
            resp.raise_for_status()
            result = resp.json()
            added += result.get("added", len(batch))
        except Exception as e:
            log(f"Error posting batch {i//batch_size}: {e}")
            # Check if it's a duplicate (HTTP 500 but might be partial)
            skipped += len(batch)

        if (i + batch_size) % 200 == 0:
            log(f"  Posted {min(i + batch_size, total)}/{total}...")

    log(f"Posted {added} comics to D1")
    return added


def main():
    log("=" * 50)
    log("Starting comic sync from labs.gay → D1")

    # Get latest date from D1
    latest_date = get_latest_date_from_d1()
    latest_ts = parse_date_ts(latest_date)
    log(f"Latest comic date from D1: {latest_date} (ts={latest_ts})")

    # Fetch new comics from API
    log("Fetching new comics from API...")
    api_new = fetch_all_new_comics(latest_ts, limit=200)

    if not api_new:
        log("No new comics found!")
        return

    log(f"Found {len(api_new)} new comics on API")

    # Get next ID
    next_id = get_next_id()
    log(f"Next available ID: {next_id}")

    # Map to gallery format
    new_gallery = map_to_gallery_format(api_new, next_id)
    log(f"Mapped {len(new_gallery)} comics (IDs {next_id}-{next_id + len(new_gallery) - 1})")

    # Post to D1
    added = post_to_d1(new_gallery)

    log("=" * 50)
    log(f"Sync complete! Added {added} new comics to D1")
    log(f"Visit: {GALLERY_API}")

    # Also update local comics.json for fallback
    local_path = REPO_DIR / JSON_PATH
    if local_path.exists():
        try:
            with open(local_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            existing_ids = {c["id"] for c in data.get("comics", [])}
            really_new = [c for c in new_gallery if c["id"] not in existing_ids]
            if really_new:
                data["comics"].extend(really_new)
                # Recalc meta
                tag_count = {}
                author_count = {}
                for c in data["comics"]:
                    author = c.get("author", "")
                    if author:
                        author_count[author] = author_count.get(author, 0) + 1
                    for tag in c.get("tags", []):
                        tag_count[tag] = tag_count.get(tag, 0) + 1
                data["tags"] = sorted(
                    [{"name": k, "count": v} for k, v in tag_count.items()],
                    key=lambda x: -x["count"]
                )
                data["authors"] = sorted(
                    [{"name": k, "count": v} for k, v in author_count.items()],
                    key=lambda x: -x["count"]
                )
                with open(local_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=1)
                log(f"Updated local {JSON_PATH} ({len(data['comics'])} comics)")

                # Also push to GitHub for fallback
                token = ""
                if GIT_TOKEN_FILE.exists():
                    token = GIT_TOKEN_FILE.read_text().strip()
                if token:
                    os.chdir(str(REPO_DIR))
                    import subprocess
                    subprocess.run(["git", "add", JSON_PATH], check=False)
                    subprocess.run(["git", "commit", "-m", f"sync: auto-add {len(really_new)} comics to D1 [{datetime.now().strftime('%Y-%m-%d')}]"], check=False)
                    remote = f"https://guodongcgd:{token}@github.com/guodongcgd/comic-gallery.git"
                    subprocess.run(["git", "push", remote], check=False, timeout=60)
                    log("Pushed updated comics.json to GitHub")
        except Exception as e:
            log(f"Warning: Could not update local comics.json: {e}")


if __name__ == "__main__":
    main()
