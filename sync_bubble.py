#!/usr/bin/env python3
import requests, json, os, unicodedata
from datetime import date

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
    """Vrátí mapu kid._id → stupen (string)."""
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
            stupen = "Dospělák"
        else:
            class_cat = k.get("class_category_option_class_category", "")
            stupen = CLASS_MAP.get(class_cat, "")
        result[k["_id"]] = stupen
    return result

def main():
    today = date.today().strftime("%Y-%m-%d") + "T04:00:00.000Z"
    print(f"Sync pro {today[:10]}...")

    meals = fetch_all("meals", [{"key": "date_date", "constraint_type": "equals", "value": today}])
    meal_map = {
        m["_id"]: {
            "nazev":     m.get("name_text", "").strip(),
            "dieta":     bool(m.get("diet_boolean", False)),
            "kategorie": m.get("type_option_meal_type", ""),
        }
        for m in meals
    }
    print(f"Jídel: {len(meals)}")

    stupen_map = fetch_kids_stupen()
    pataci = nacti_pataky()

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
        stupen = stupen_map.get(kid_id, "")
        jidlo_meta  = meal_map.get(o.get("meal_custom_meals", ""), {})
        polevka_meta = meal_map.get(o.get("soup_custom_meals", ""), {})
        export.append({
            "uuid":       kid_id,
            "jmeno":      jmeno,
            "jidlo":      jidlo_meta.get("nazev", ""),
            "jidlo_dieta": jidlo_meta.get("dieta", False),
            "jidlo_kat":  jidlo_meta.get("kategorie", ""),
            "polevka":    polevka_meta.get("nazev", ""),
            "stupen":     stupen,
            "skupina":    skupina_pro(jmeno, kid_id, stupen, pataci),
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
            "constraints": json.dumps([{"key": "active", "constraint_type": "equals", "value": "true"}])
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
        })
    with open(f"{DATA}/vsichni.json", "w", encoding="utf-8") as f:
        json.dump(vsichni, f, ensure_ascii=False, indent=2)
    print(f"vsichni.json: {len(vsichni)} dětí")

    requests.get("http://localhost:3000/reload", timeout=5)
    print("Server reloadován ✓")

if __name__ == "__main__":
    main()
