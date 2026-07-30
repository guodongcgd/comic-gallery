#!/usr/bin/env python3
"""
Sync new comics from api-comic.labs.gay to comic-gallery.
Compares by posted timestamp, adds only new comics.
Updates comics.json, commits and pushes to GitHub.
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

API_BROWSE = "https://api-comic.labs.gay/api/browse?indexUid=gaylabs"
REPO_DIR = Path("/home/agentuser/comic-gallery")
JSON_PATH = "comics.json"
GIT_TOKEN_FILE = Path("/home/agentuser/.hermes/.github_token")


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def load_current_data():
    """Load existing comics.json from GitHub raw."""
    url = "https://raw.githubusercontent.com/guodongcgd/comic-gallery/main/comics.json"
    resp = httpx.get(url, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    return resp.json()


def get_latest_date(data):
    """Get the latest published_at date from existing comics."""
    dates = []
    for c in data.get("comics", []):
        d = c.get("published_at", "").strip()
        if d:
            dates.append(d)
    dates.sort(reverse=True)
    return dates[0] if dates else "2020-01-01 00:00"


def parse_date_for_cmp(date_str):
    """Parse date string for comparison. Returns timestamp int."""
    date_str = date_str.strip()
    for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"]:
        try:
            dt = datetime.strptime(date_str, fmt)
            return int(dt.timestamp())
        except ValueError:
            continue
    return 0


def extract_author(title_jp):
    """Extract author name from title like [Author Name] ..."""
    m = re.match(r'^\[([^\]]+)\]', title_jp)
    if m:
        return m.group(1).strip()
    return ""


def extract_tags(category_path_zh):
    """Extract simple tags from category_path_zh (take the part after '> ')."""
    tags = []
    for path in category_path_zh:
        parts = path.split("> ")
        if len(parts) >= 2:
            tag = parts[-1].strip()
            if tag and tag not in tags:
                tags.append(tag)
    return tags


def extract_title_cn(title_jp, title_en):
    """Extract Chinese title from various formats."""
    # Try to get Chinese part after ︱ or | separator
    for sep in ["︱", "|", "｜"]:
        if sep in title_jp:
            after = title_jp.split(sep, 1)[1]
            # Remove tags like [Chinese][单][单行本]
            after = re.sub(r'\[.*?\]', '', after).strip()
            if after:
                return after

    # Try from title_en
    for sep in ["︱", "|", "｜"]:
        if sep in title_en:
            after = title_en.split(sep, 1)[1]
            after = re.sub(r'\[.*?\]', '', after).strip()
            if after:
                return after

    # Fallback: use title_en without author prefix and tags
    title = title_en
    title = re.sub(r'^\[[^\]]*\]\s*', '', title)
    title = re.sub(r'\s*\[.*?\]', '', title)
    title = title.strip()
    if title:
        return title

    # Last resort
    return title_jp[:60] if len(title_jp) > 60 else title_jp


def extract_title_original(title_jp):
    """Clean up the original title."""
    title = title_jp.strip()
    # Remove trailing tags like [Chinese][単][単行本]
    title = re.sub(r'\s*\[[^\]]*\]\s*$', '', title)
    return title


def fetch_all_new_comics(latest_date_ts, limit=100):
    """
    Fetch all comics newer than latest_date_ts from the API.
    Returns list of comics sorted by postedTimestamp descending.
    """
    new_comics = []
    page = 1
    hits_per_page = 200  # Max per page

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
            # Since results are sorted newest-first, once we hit old enough,
            # remaining pages will also be old
            # But we can't break because pagination continues

        total_pages = data.get("totalPages", 1)
        log(f"  Got {len(hits)} hits, {len(new_comics)} new so far (page {page}/{total_pages})")

        if page >= total_pages:
            break

        # If the last hit is older than our cutoff, remaining pages are all old
        if hits and hits[-1].get("postedTimestamp", 0) <= latest_date_ts:
            log(f"  Reached cutoff at page {page}, stopping")
            break

        page += 1

        # Be polite to API
        time.sleep(0.5)

        if len(new_comics) >= limit:
            log(f"  Reached limit of {limit} new comics")
            break

    # Sort by postedTimestamp ascending (oldest first for proper ID assignment)
    new_comics.sort(key=lambda x: x.get("postedTimestamp", 0))
    return new_comics


def map_to_gallery_format(api_comics, next_id):
    """Map API comic format to gallery format."""
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


def recalculate_meta(comics):
    """Recalculate tags and authors arrays from comics list."""
    tag_count = {}
    author_count = {}
    for c in comics:
        author = c.get("author", "")
        if author:
            author_count[author] = author_count.get(author, 0) + 1
        for tag in c.get("tags", []):
            tag_count[tag] = tag_count.get(tag, 0) + 1

    new_tags = sorted(
        [{"name": k, "count": v} for k, v in tag_count.items()],
        key=lambda x: -x["count"]
    )
    new_authors = sorted(
        [{"name": k, "count": v} for k, v in author_count.items()],
        key=lambda x: -x["count"]
    )
    return new_tags, new_authors


def write_and_push(data):
    """Write updated comics.json to repo, commit, push."""
    json_path = REPO_DIR / JSON_PATH

    log(f"Writing {len(data['comics'])} comics to {json_path}")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    # Git operations
    token = ""
    if GIT_TOKEN_FILE.exists():
        token = GIT_TOKEN_FILE.read_text().strip()

    if not token:
        token = os.environ.get("GITHUB_TOKEN", "")
        if not token:
            log("WARNING: No GitHub token found, skipping push")
            return

    os.chdir(str(REPO_DIR))
    subprocess.run(["git", "add", JSON_PATH], check=True)
    subprocess.run(
        ["git", "commit", "-m", f"sync: auto-add {len(data['comics'])} comics from labs.gay"],
        check=False,
    )

    # Push with token auth
    remote = f"https://guodongcgd:{token}@github.com/guodongcgd/comic-gallery.git"
    result = subprocess.run(
        ["git", "push", remote],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        log(f"Push stderr: {result.stderr[:200]}")
        # Fallback: pull rebase and retry
        log("Pull rebase and retry...")
        subprocess.run(["git", "pull", "--rebase", remote], check=False, timeout=30)
        subprocess.run(["git", "push", remote], check=False, timeout=60)

    log("Push complete")


def main():
    log("=" * 50)
    log("Starting comic sync from labs.gay")

    # Load current data
    log("Loading current data...")
    data = load_current_data()
    comics = data.get("comics", [])
    log(f"Current: {len(comics)} comics")

    # Find latest date
    latest_date = get_latest_date(data)
    latest_ts = parse_date_for_cmp(latest_date)
    log(f"Latest comic date: {latest_date} (ts={latest_ts})")

    # Fetch new comics from API
    log("Fetching new comics from API...")
    api_new = fetch_all_new_comics(latest_ts, limit=500)

    if not api_new:
        log("No new comics found!")
        return

    log(f"Found {len(api_new)} new comics on API")

    # Map to gallery format
    next_id = max((c.get("id", 0) for c in comics), default=0) + 1
    new_gallery = map_to_gallery_format(api_new, next_id)
    log(f"Mapped {len(new_gallery)} comics (IDs {next_id}-{next_id + len(new_gallery) - 1})")

    # Merge
    all_comics = comics + new_gallery
    log(f"Total comics: {len(all_comics)}")

    # Recalculate meta
    new_tags, new_authors = recalculate_meta(all_comics)
    log(f"Tags: {len(new_tags)}, Authors: {len(new_authors)}")

    # Build output data
    output = {
        "comics": all_comics,
        "tags": new_tags,
        "authors": new_authors,
    }

    # Write and push
    write_and_push(output)

    log("=" * 50)
    log(f"Sync complete! Added {len(new_gallery)} comics")
    log(f"Now {len(all_comics)} total comics")


if __name__ == "__main__":
    main()
