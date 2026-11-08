"""Write data/backdrops.json: trending films and series with textless 4K backdrops from TMDB.

Runs daily in GitHub Actions with the key in the TMDB_KEY secret, so the key never sits in the repo.
Locally: TMDB_KEY=... python3 scripts/fetch_backdrops.py   (or put the key in tmdb.key, which git ignores)
Accepts either a v3 API key or a v4 read access token. Standard library only.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p/original"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "backdrops.json")
WANT = 30          # how many backdrops to keep
MIN_WIDTH = 3840   # true 4K first; 2560 wide is accepted only if there are too few


def read_key():
    key = os.environ.get("TMDB_KEY", "").strip()
    if not key:
        path = os.path.join(os.path.dirname(__file__), "..", "tmdb.key")
        if os.path.exists(path):
            key = open(path).read().strip()
    if not key:
        sys.exit("No TMDB key: set TMDB_KEY or create tmdb.key")
    return key


def get(key, path, **params):
    headers = {"Accept": "application/json", "User-Agent": "tvhome/1.0"}
    if len(key) > 40:                      # v4 read access token
        headers["Authorization"] = "Bearer " + key
    else:                                  # v3 api key
        params["api_key"] = key
    url = API + path + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
        return json.load(r)


def best_backdrop(key, kind, item_id, min_width):
    # include_image_language=null returns backdrops without any title text on them.
    images = get(key, "/%s/%d/images" % (kind, item_id), include_image_language="null").get("backdrops", [])
    wide = [b for b in images if b.get("width", 0) >= min_width and abs(b["width"] / b["height"] - 16 / 9) < 0.05]
    if not wide:
        return None
    wide.sort(key=lambda b: (b.get("vote_average", 0), b.get("vote_count", 0), b["width"]), reverse=True)
    return wide[0]


MONTHS = ["ledna", "února", "března", "dubna", "května", "června",
          "července", "srpna", "září", "října", "listopadu", "prosince"]


def cz_date(iso):
    y, m, d = iso[:10].split("-")
    return "%d. %s" % (int(d), MONTHS[int(m) - 1])


def cinema_lists(key):
    """Film IDs playing in Czech cinemas now, and the Czech release date of those coming soon."""
    now, soon = set(), {}
    for page in (1, 2, 3):
        for m in get(key, "/movie/now_playing", region="CZ", page=page).get("results", []):
            now.add(m["id"])
        for m in get(key, "/movie/upcoming", region="CZ", page=page).get("results", []):
            if m.get("release_date"):
                soon[m["id"]] = m["release_date"]
    return now, soon


def details(key, kind, item_id, now, soon):
    """Short facts for the info panel: synopsis, genres, length, rating, cinema status, where to stream."""
    d = get(key, "/%s/%d" % (kind, item_id), language="cs-CZ", append_to_response="watch/providers")
    overview = (d.get("overview") or "").strip()
    if not overview:
        overview = (get(key, "/%s/%d" % (kind, item_id), language="en-US").get("overview") or "").strip()
    info = {
        "overview": overview,
        "genres": [g["name"] for g in d.get("genres", [])][:3],
        "providers": [p["provider_name"] for p in
                      d.get("watch/providers", {}).get("results", {}).get("CZ", {}).get("flatrate", [])][:4],
    }
    if d.get("vote_count", 0) >= 50:
        info["rating"] = round(d.get("vote_average", 0), 1)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if kind == "movie":
        if d.get("runtime"):
            info["length"] = "%d h %d min" % divmod(d["runtime"], 60) if d["runtime"] >= 60 else "%d min" % d["runtime"]
        if item_id in now:
            info["status"] = "V kinech"
        elif soon.get(item_id, "") > today:
            info["status"] = "V kinech od " + cz_date(soon[item_id])
    else:
        n = d.get("number_of_seasons")
        if n:
            info["length"] = "%d %s" % (n, "řada" if n == 1 else "řady" if n < 5 else "řad")
        nxt = (d.get("next_episode_to_air") or {}).get("air_date")
        if nxt and nxt >= today:
            info["status"] = "Nový díl " + cz_date(nxt)
    if not info.get("status") and info["providers"]:
        info["status"] = "Na " + info["providers"][0]
    return info


def main():
    key = read_key()
    now, soon = cinema_lists(key)
    candidates = []
    for page in (1, 2, 3):
        for item in get(key, "/trending/all/week", language="cs-CZ", page=page).get("results", []):
            if item.get("media_type") in ("movie", "tv") and not item.get("adult"):
                candidates.append(item)

    items, seen = [], set()
    for min_width in (MIN_WIDTH, 2560):
        for c in candidates:
            if len(items) >= WANT:
                break
            if c["id"] in seen:
                continue
            b = best_backdrop(key, c["media_type"], c["id"], min_width)
            if not b:
                continue
            seen.add(c["id"])
            date = c.get("release_date") or c.get("first_air_date") or ""
            item = {
                "title": c.get("title") or c.get("name"),
                "year": date[:4],
                "kind": c["media_type"],
                "src": IMG + b["file_path"],
                "width": b["width"],
                "height": b["height"],
            }
            try:
                item.update(details(key, c["media_type"], c["id"], now, soon))
            except Exception as e:          # a missing detail never costs the backdrop
                print("no details for %s: %s" % (item["title"], e))
            items.append(item)
        if len(items) >= WANT:
            break

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({
            "source": "TMDB trending this week, streaming data by JustWatch. This product uses the TMDB API but is not endorsed or certified by TMDB.",
            "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "items": items,
        }, f, ensure_ascii=False, indent=1)
    print("wrote %d backdrops (%d at 3840+ wide)" % (len(items), sum(1 for i in items if i["width"] >= 3840)))


if __name__ == "__main__":
    main()
