#!/usr/bin/env python3
"""Import comics.json into Cloudflare D1 database in batches."""
import json
import subprocess
import sys
import time
from pathlib import Path

BATCH_SIZE = 50
JSON_PATH = Path(__file__).parent / "comics.json"
DB = "comic-gallery-db"

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def sql_escape(val):
    """Escape a string value for SQL INSERT."""
    if val is None:
        return "NULL"
    escaped = str(val).replace("'", "''")
    return f"'{escaped}'"

def build_insert(comics_batch):
    """Build a bulk INSERT statement for a batch of comics."""
    values = []
    for c in comics_batch:
        tags_json = json.dumps(c.get("tags", []), ensure_ascii=False)
        v = (
            f"({c['id']}, "
            f"{sql_escape(c.get('title_cn', ''))}, "
            f"{sql_escape(c.get('title_original', ''))}, "
            f"{sql_escape(c.get('cover_url', ''))}, "
            f"{sql_escape(c.get('author', ''))}, "
            f"{sql_escape(tags_json)}, "
            f"{sql_escape(c.get('telegraph_url', ''))}, "
            f"{sql_escape(c.get('telegram_url', ''))}, "
            f"{sql_escape(c.get('published_at', ''))}, "
            f"{c.get('pages', 0)}, "
            f"{c.get('stars', 0)})"
        )
        values.append(v)
    
    sql = (
        "INSERT OR IGNORE INTO comics "
        "(id, title_cn, title_original, cover_url, author, tags, "
        "telegraph_url, telegram_url, published_at, pages, stars) "
        "VALUES " + ",\n".join(values) + ";"
    )
    return sql

def main():
    log("Loading comics.json...")
    with open(JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    comics = data["comics"]
    total = len(comics)
    log(f"Total comics to import: {total}")
    
    # Check current D1 count
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB, 
         "--command", "SELECT COUNT(*) as cnt FROM comics;", 
         "--remote", "--json"],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode == 0:
        import json as j
        try:
            out = j.loads(result.stdout)
            existing = out[0]["results"][0]["cnt"] if out[0].get("results") else 0
            log(f"Existing comics in D1: {existing}")
            if existing >= total:
                log("Already fully imported, skipping.")
                return
        except:
            pass
    
    imported = 0
    for i in range(0, total, BATCH_SIZE):
        batch = comics[i:i + BATCH_SIZE]
        sql = build_insert(batch)
        
        result = subprocess.run(
            ["npx", "wrangler", "d1", "execute", DB,
             "--command", sql,
             "--remote", "--json"],
            capture_output=True, text=True, timeout=60
        )
        
        if result.returncode != 0:
            log(f"ERROR at batch {i//BATCH_SIZE}: {result.stderr[:300]}")
            log("Retrying with single inserts...")
            # Fallback: insert one by one
            for c in batch:
                s = build_insert([c])
                subprocess.run(
                    ["npx", "wrangler", "d1", "execute", DB,
                     "--command", s, "--remote"],
                    capture_output=True, timeout=30
                )
                imported += 1
        else:
            imported += len(batch)
        
        if i % 500 == 0:
            log(f"Progress: {imported}/{total}")
    
    log(f"Import complete! {imported}/{total} comics inserted.")
    
    # Verify
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB,
         "--command", "SELECT COUNT(*) as cnt, MAX(id) as max_id, MAX(published_at) as latest FROM comics;",
         "--remote", "--json"],
        capture_output=True, text=True, timeout=30
    )
    log(f"Verification: {result.stdout}")

if __name__ == "__main__":
    main()
