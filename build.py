"""나무 링크런 빌드.

1. linkrun.user.js 내용을 linkrun.html 안의 <script type="text/plain" id="userscript-src">에 넣고,
   pool.json(랜덤 출제 문서 목록)을 const POOL 자리에 넣어요. (claude.ai 게시용 linkrun.html)
2. 같은 내용으로 사이트용 docs/index.html을 만들어요. (GitHub Pages + Firebase)

스크립트나 페이지를 고친 뒤 게시하기 전에 실행하세요:  python build.py
"""
import json
import re
from pathlib import Path

FIREBASE_VERSION = "10.12.2"
# Pretendard는 Google Fonts에 없어서 사이트에서만 jsDelivr로 불러와요.
# (claude.ai 버전은 보안 규칙상 못 불러와서 시스템 글꼴로 보여요.)
PRETENDARD_CSS = "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"

here = Path(__file__).parent
html_path = here / "linkrun.html"
src = (here / "linkrun.user.js").read_text(encoding="utf-8")

if "</script" in src.lower():
    raise SystemExit("linkrun.user.js 안에 </script 가 있으면 페이지에 넣을 수 없어요.")

html = html_path.read_text(encoding="utf-8")
pattern = re.compile(r'(<script type="text/plain" id="userscript-src">)[\s\S]*?(</script>)')
if not pattern.search(html):
    raise SystemExit('linkrun.html에서 <script type="text/plain" id="userscript-src"> 자리를 찾지 못했어요.')

html = pattern.sub(lambda m: m.group(1) + "\n" + src + m.group(2), html, count=1)

# 랜덤 출제용 문서 목록: pool.json → const POOL = /*POOL*/{...}/*POOL*/;
pool = json.loads((here / "pool.json").read_text(encoding="utf-8"))
seen = {}
for cat, titles in pool.items():
    if not titles:
        raise SystemExit(f"pool.json: '{cat}' 분류가 비어 있어요.")
    for t in titles:
        key = t.strip().lower()
        if key in seen:
            raise SystemExit(f"pool.json: '{t}'가 '{seen[key]}'와 '{cat}'에 두 번 들어 있어요.")
        seen[key] = cat
# 금지 문서 묶음: bans.json → const BANS = /*BANS*/{...}/*BANS*/;
bans = json.loads((here / "bans.json").read_text(encoding="utf-8"))
for key, b in bans.items():
    if not re.fullmatch(r"[a-z]+", key) or "name" not in b or not isinstance(b.get("titles"), list):
        raise SystemExit(f"bans.json: '{key}' 형식이 이상해요. (영문 소문자 키, name, titles 필요)")
    if not b["titles"] and not b.get("patterns"):
        raise SystemExit(f"bans.json: '{key}'에 titles도 patterns도 없어요.")
if "/*BANS*/" not in html:
    raise SystemExit("linkrun.html에서 /*BANS*/ 자리를 찾지 못했어요.")
bans_js = json.dumps(bans, ensure_ascii=False).replace("</", "<\\/")
html = re.sub(r"/\*BANS\*/[\s\S]*?/\*BANS\*/", lambda m: "/*BANS*/" + bans_js + "/*BANS*/", html, count=1)

if "/*POOL*/" not in html:
    raise SystemExit("linkrun.html에서 /*POOL*/ 자리를 찾지 못했어요.")
pool_js = json.dumps(pool, ensure_ascii=False).replace("</", "<\\/")
html = re.sub(r"/\*POOL\*/[\s\S]*?/\*POOL\*/", lambda m: "/*POOL*/" + pool_js + "/*POOL*/", html, count=1)
html_path.write_text(html, encoding="utf-8")

# 사이트용: claude.ai가 대신 붙여주던 문서 뼈대(charset, viewport, 기본 스타일)를 직접 붙여요.
site_dir = here / "docs"
site_dir.mkdir(exist_ok=True)
site = f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="{PRETENDARD_CSS}">
<style>:root{{color-scheme:light}}body{{margin:0}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
<script src="https://www.gstatic.com/firebasejs/{FIREBASE_VERSION}/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/{FIREBASE_VERSION}/firebase-firestore-compat.js"></script>
<script src="firebase-config.js"></script>
</head>
<body>
{html}
</body>
</html>
"""
(site_dir / "index.html").write_text(site, encoding="utf-8")

config = site_dir / "firebase-config.js"
if not config.exists():
    config.write_text(
        "// Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹)에 나오는 firebaseConfig 값을 아래에 붙여넣으세요.\n"
        "// 비어 있으면(null) 혼자 연습 모드로 열려요.\n"
        "window.LINKRUN_FIREBASE = null;\n"
        "/* 예시\n"
        "window.LINKRUN_FIREBASE = {\n"
        '  apiKey: "AIza...",\n'
        '  authDomain: "내프로젝트.firebaseapp.com",\n'
        '  projectId: "내프로젝트",\n'
        '  storageBucket: "내프로젝트.appspot.com",\n'
        '  messagingSenderId: "1234567890",\n'
        '  appId: "1:1234567890:web:abcdef"\n'
        "};\n"
        "*/\n",
        encoding="utf-8",
    )

version = re.search(r"@version\s+(\S+)", src)
print("완료: linkrun.html, docs/index.html  (스크립트", version.group(1) if version else "?",
      f"· 문서 {len(seen)}개 / 분류 {len(pool)}개)")
