#!/usr/bin/env python3
import requests, json, os
from datetime import date

TOKEN = "c39e7242f33f9be6926edd5c15921c21"
BASE = "https://menu.skolavela.cz/api/1.1/obj"
DATA = "/home/velan/velamenu-vydej/data"
H = {"Authorization": f"Bearer {TOKEN}"}

CLASS_MAP = {
    "Nultý":  "Předškolák",
    "První":  "První stupeň",
    "Druhý":  "Druhý stupeň",
}

def fetch_all(endpoint, constraints):
    results, cursor = [], 0
    while True:
        r = requests.get(f"{BASE}/{endpoint}", headers=H, params={
            "limit": 100, "cursor": cursor,
            "constraints": json.dumps(constraints)
        })
        d = r.json()["response"]
        results.extend(d["results"])
        if d.get("remaining", 0) == 0: break
        cursor += 100
    return results

def fetch_kids_stupen():
    """Vrátí mapu kid._id → stupen string."""
    kids, cursor = [], 0
    while True:
        r = requests.get(f"{BASE}/kids", headers=H, params={"limit": 100, "cursor": cursor})
        d = r.json()["response"]
        kids.extend(d["results"])
        if d.get("remaining", 0) == 0: break
        cursor += 100
    print(f"Kids načteno: {len(kids)}")
    result = {}
    for k in kids:
        if k.get("kid_category_option_kid_category") == "Dospělák":
            result[k["_id"]] = "Dospělák"
        else:
            class_cat = k.get("class_category_option_class_category", "")
            result[k["_id"]] = CLASS_MAP.get(class_cat, "")
    return result

def main():
    today = date.today().strftime("%Y-%m-%d") + "T04:00:00.000Z"
    print(f"Sync pro {today[:10]}...")

    meals = fetch_all("meals", [{"key": "date", "constraint_type": "equals", "value": today}])
    meal_map = {m["_id"]: m.get("name_text", "").strip() for m in meals}
    print(f"Jídel: {len(meals)}")

    stupen_map = fetch_kids_stupen()

    orders = fetch_all("orders", [
        {"key": "date", "constraint_type": "equals", "value": today},
        {"key": "deactivate", "constraint_type": "equals", "value": "false"}
    ])
    print(f"Objednávek: {len(orders)}")

    export = []
    for o in orders:
        jmeno = o.get("kid_fullname_text", "").strip()
        if not jmeno:
            continue
        kid_id = o.get("kid_custom_kids", "")
        export.append({
            "uuid":    kid_id,
            "jmeno":   jmeno,
            "jidlo":   meal_map.get(o.get("meal_custom_meals", ""), ""),
            "polevka": meal_map.get(o.get("soup_custom_meals", ""), ""),
            "stupen":  stupen_map.get(kid_id, ""),
        })

    with open(f"{DATA}/export.json", "w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, indent=2)
    print(f"Uloženo: {len(export)} záznamů")

    requests.get("http://localhost:3000/reload", timeout=5)
    print("Server reloadován ✓")

if __name__ == "__main__":
    main()
