#!/usr/bin/env python3
import requests, json, os, unicodedata
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

BASE = "https://menu.skolavela.cz/api/1.1/obj"
DATA = "/home/velan/velamenu-vydej/data"
with open(f"{DATA}/config.json", encoding="utf-8") as f:
    TOKEN = json.load(f)["bubbleToken"]
H = {"Authorization": f"Bearer {TOKEN}"}

CLASS_MAP = {
    "Nultý":  "Předškolák",
    "První":  "První stupeň",
    "Druhý":  "Druhý stupeň",
}


def norm(s):
    """Tolerantní normalizace jména: trim, sloučení mezer, lowercase, bez diakritiky."""
    s = " ".join(str(s or "").split()).lower()
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def nacti_pataky():
    """Načte data/pataci.txt → množina normalizovaných jmen (i UUID) páťáků.
    Páťáci patří porcí na první stupeň, ale ve výběru/statistikách je chceme pod Druhým stupněm."""
    cesta = f"{DATA}/pataci.txt"
    if not os.path.exists(cesta):
        return set()
    pataci = set()
    with open(cesta, encoding="utf-8") as f:
        for radek in f:
            r = radek.strip()
            if not r or r.startswith("#"):
                continue
            pataci.add(norm(r))
    print(f"Páťáků v seznamu: {len(pataci)}")
    return pataci


def skupina_pro(jmeno, uuid, stupen, pataci):
    """Zobrazovací skupina — páťáci pod Druhý stupeň, jinak = stupen."""
    if norm(jmeno) in pataci or norm(uuid) in pataci:
        return "Druhý stupeň"
    return stupen


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
    """Vrátí mapu kid._id → { stupen, dieta }."""
    kids, cursor = [], 0
    while True:
        r = requests.get(f"{BASE}/kids", headers=H, params={
            "limit": 100, "cursor": cursor,
            "constraints": json.dumps([{"key": "campus", "constraint_type": "equals", "value": "P14"}])
        })
        d = r.json()["response"]
        kids.extend(d["results"])
        if d.get("remaining", 0) == 0: break
        cursor += 100
    print(f"Kids načteno: {len(kids)}")
    result = {}
    for k in kids:
        if k.get("kid_category_option_kid_category") == "Dospělák":
            stupen = "Dospělák"
        else:
            class_cat = k.get("class_category_option_class_category", "")
            stupen = CLASS_MAP.get(class_cat, "")
        result[k["_id"]] = {"stupen": stupen, "dieta": bool(k.get("diet_boolean", False))}
    return result


TZ = ZoneInfo("Europe/Prague")

def den_rozsah_utc(d):
    """Cely den d v prazskem case jako (od, do) UTC ISO retezce pro rozsahovy dotaz."""
    zacatek = datetime(d.year, d.month, d.day, tzinfo=TZ) - timedelta(seconds=1)
    konec = datetime(d.year, d.month, d.day, tzinfo=TZ) + timedelta(days=1)
    fmt = lambda dt: dt.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return fmt(zacatek), fmt(konec)

def main():
    dnes = date.today()
    den_od, den_do = den_rozsah_utc(dnes)
    print(f"Sync pro {dnes.isoformat()}...")

    meals = fetch_all("meals", [
        {"key": "date", "constraint_type": "greater than", "value": den_od},
        {"key": "date", "constraint_type": "less than", "value": den_do},
    ])
    meal_map = {m["_id"]: m.get("name_text", "").strip() for m in meals}
    print(f"Jídel: {len(meals)}")

    stupen_map = fetch_kids_stupen()
    pataci = nacti_pataky()

    orders = fetch_all("orders", [
        {"key": "date", "constraint_type": "greater than", "value": den_od},
        {"key": "date", "constraint_type": "less than", "value": den_do},
        {"key": "deactivate", "constraint_type": "equals", "value": "false"}
    ])
    print(f"Objednávek: {len(orders)}")

    export = []
    for o in orders:
        jmeno = o.get("kid_fullname_text", "").strip()
        if not jmeno:
            continue
        kid_id = o.get("kid_custom_kids", "")
        if kid_id not in stupen_map:
            continue  # dite z jine pobocky (napr. Praha 6) - preskocit
        meta   = stupen_map[kid_id]
        stupen = meta["stupen"]
        export.append({
            "uuid":    kid_id,
            "jmeno":   jmeno,
            "jidlo":   meal_map.get(o.get("meal_custom_meals", ""), ""),
            "polevka": meal_map.get(o.get("soup_custom_meals", ""), ""),
            "stupen":  stupen,
            "skupina": skupina_pro(jmeno, kid_id, stupen, pataci),
            "dieta":   meta["dieta"],
        })

    with open(f"{DATA}/export.json", "w", encoding="utf-8") as f:
        json.dump(export, f, ensure_ascii=False, indent=2)
    print(f"Uloženo: {len(export)} záznamů")

    # vsichni.json — všechny aktivní děti (bez ohledu na dnešní objednávku)
    vsichni_raw = []
    cursor = 0
    while True:
        r = requests.get(f"{BASE}/kids", headers=H, params={
            "limit": 100, "cursor": cursor,
            "constraints": json.dumps([
                {"key": "active", "constraint_type": "equals", "value": "true"},
                {"key": "campus", "constraint_type": "equals", "value": "P14"}
            ])
        })
        d = r.json()["response"]
        vsichni_raw.extend(d["results"])
        if d.get("remaining", 0) == 0:
            break
        cursor += 100
    vsichni = []
    for k in vsichni_raw:
        jmeno = (k.get("fullname_text") or "").strip()
        if not jmeno:
            continue
        if k.get("kid_category_option_kid_category") == "Dospělák":
            stupen = "Dospělák"
        else:
            class_cat = k.get("class_category_option_class_category", "")
            stupen = CLASS_MAP.get(class_cat, "")
        vsichni.append({
            "uuid": k["_id"], "jmeno": jmeno, "stupen": stupen,
            "skupina": skupina_pro(jmeno, k["_id"], stupen, pataci),
            "dieta": bool(k.get("diet_boolean", False)),
        })
    with open(f"{DATA}/vsichni.json", "w", encoding="utf-8") as f:
        json.dump(vsichni, f, ensure_ascii=False, indent=2)
    print(f"vsichni.json: {len(vsichni)} dětí")

    requests.get("http://localhost:3000/reload", timeout=5)
    print("Server reloadován ✓")

if __name__ == "__main__":
    main()
