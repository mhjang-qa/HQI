import json
import math
import os
import re
import sqlite3
import threading
import time
import traceback
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


NOTION_VERSION = "2022-06-28"
REQUEST_TIMEOUT_SECONDS = 60
NOTION_MIN_REQUEST_INTERVAL_SECONDS = 0.4
NOTION_RATE_LOCK = threading.Lock()
NOTION_LAST_REQUEST_AT = 0.0
HQI_CACHE_TTL_SECONDS = 600
HQI_CACHE = {"created": 0.0, "data": None}
DB_PATH = Path(__file__).with_name("hqi_results.sqlite3")
TC_DATABASE_IDS = [
    ("정기 업데이트", "2ee73fbd19518041a70fc6192d387f5e"),
    ("비정기 업데이트", "34473fbd195180d7b8bfe8073c543220"),
]
ISSUE_DATABASE_ID = "21473fbd1951800d8321fc2e34c2548e"
TC_COUNT_PROPERTIES = ("TC cnt", "TC Count", "TC 개수", "테스트 케이스 수")
TC_PROGRESS_PROPERTIES = ("테스트 진행율", "진행율", "수행율", "Progress")
DONE_STATUS_KEYWORDS = (
    "완료",
    "done",
    "dev done",
    "결함 아님",
    "not an issue",
    "추후 수정",
    "백로그 이관",
)
OPEN_COUNT_EXCLUDED_STATUS_KEYWORDS = (
    "qa검증-회귀",
    "추적관찰-백로그",
    "추적관찰-백로그이관",
    "추척관찰-백로그",
    "추척관찰-백로그이관",
)
HIDDEN_PROJECT_STATUSES = ("시작 전",)


def notion_token():
    token = os.getenv("NOTION_TOKEN", "").strip()
    if not token:
        raise RuntimeError("NOTION_TOKEN 환경변수가 필요합니다.")
    return token


def notion_request(path, payload=None):
    global NOTION_LAST_REQUEST_AT
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    for attempt in range(7):
        with NOTION_RATE_LOCK:
            now = time.time()
            elapsed = now - NOTION_LAST_REQUEST_AT
            if elapsed < NOTION_MIN_REQUEST_INTERVAL_SECONDS:
                time.sleep(NOTION_MIN_REQUEST_INTERVAL_SECONDS - elapsed)
            NOTION_LAST_REQUEST_AT = time.time()
        req = urllib.request.Request(
            f"https://api.notion.com/v1{path}",
            data=body,
            method="POST" if payload is not None else "GET",
            headers={
                "Authorization": f"Bearer {notion_token()}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 6:
                retry_after = exc.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else min(12, 1.5 * (attempt + 1))
                time.sleep(delay)
                continue
            raise
        except (TimeoutError, urllib.error.URLError):
            if attempt < 6:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise RuntimeError("Notion API 요청 실패")


def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS hqi_results (
            project_id TEXT PRIMARY KEY,
            project_name TEXT NOT NULL,
            category TEXT NOT NULL,
            project_last_edited TEXT,
            issue_db_last_edited TEXT,
            calculated_at TEXT NOT NULL,
            data_json TEXT NOT NULL
        )
        """
    )
    return conn


def save_result(result, project_last_edited, issue_db_last_edited):
    calculated_at = datetime.now(timezone.utc).isoformat()
    result = {**result, "calculatedAt": calculated_at}
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO hqi_results (
                project_id, project_name, category, project_last_edited,
                issue_db_last_edited, calculated_at, data_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                project_name = excluded.project_name,
                category = excluded.category,
                project_last_edited = excluded.project_last_edited,
                issue_db_last_edited = excluded.issue_db_last_edited,
                calculated_at = excluded.calculated_at,
                data_json = excluded.data_json
            """,
            (
                result["id"],
                result["project"],
                result["category"],
                project_last_edited,
                issue_db_last_edited,
                calculated_at,
                json.dumps(result, ensure_ascii=False),
            ),
        )
    return result


def load_saved_results():
    with db_connection() as conn:
        rows = conn.execute("SELECT data_json FROM hqi_results ORDER BY calculated_at DESC").fetchall()
    return visible_projects(json.loads(row["data_json"]) for row in rows)


def load_saved_result(project_id):
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM hqi_results WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    if not row:
        return None
    data = json.loads(row["data_json"])
    return {**dict(row), "data": data}


def query_database(database_id):
    rows = []
    cursor = None
    while True:
        payload = {"page_size": 100}
        if cursor:
            payload["start_cursor"] = cursor
        data = notion_request(f"/databases/{database_id}/query", payload)
        rows.extend(data.get("results", []))
        cursor = data.get("next_cursor")
        if not cursor:
            return rows


def get_block_children(block_id):
    rows = []
    cursor = None
    while True:
        suffix = f"&start_cursor={cursor}" if cursor else ""
        data = notion_request(f"/blocks/{block_id}/children?page_size=100{suffix}")
        rows.extend(data.get("results", []))
        cursor = data.get("next_cursor")
        if not cursor:
            return rows


def discover_child_databases(block_id, depth=0, max_depth=5, seen=None):
    if seen is None:
        seen = set()
    if depth > max_depth or block_id in seen:
        return []
    seen.add(block_id)

    databases = []
    for block in get_block_children(block_id):
        block_type = block.get("type")
        if block_type == "child_database":
            databases.append(
                {
                    "id": block["id"],
                    "title": block.get("child_database", {}).get("title") or "TC DB",
                }
            )
            continue
        if block.get("has_children"):
            databases.extend(discover_child_databases(block["id"], depth + 1, max_depth, seen))
    return databases


def rich_text(items):
    return "".join(item.get("plain_text", "") for item in items or [])


def prop_value(props, name):
    prop = props.get(name) or {}
    typ = prop.get("type")
    if typ == "title":
        return rich_text(prop.get("title"))
    if typ == "rich_text":
        return rich_text(prop.get("rich_text"))
    if typ == "number":
        return prop.get("number")
    if typ == "select":
        selected = prop.get("select")
        return selected.get("name") if selected else ""
    if typ == "status":
        status = prop.get("status")
        return status.get("name") if status else ""
    if typ == "date":
        date = prop.get("date")
        return date.get("start") if date else ""
    if typ == "unique_id":
        unique = prop.get("unique_id") or {}
        prefix = unique.get("prefix") or ""
        number = unique.get("number")
        return f"{prefix}-{number}" if number is not None else prefix
    return ""


def normalize_project_name(name):
    cleaned = re.sub(r"\s+", " ", name or "").strip()
    cleaned = re.sub(r"\s*테스트\s*케이스\s*$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s*test\s*case\s*$", "", cleaned, flags=re.I)
    return cleaned.strip()


def match_key(name):
    return re.sub(r"[^0-9a-z가-힣]+", "", normalize_project_name(name).lower())


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def as_ratio(value):
    if value is None:
        return 0.0
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0.0
    if value > 1:
        value = value / 100
    return clamp(value)


def is_done_status(status):
    text = (status or "").lower()
    return any(keyword.lower() in text for keyword in DONE_STATUS_KEYWORDS)


def normalize_status_key(status):
    return re.sub(r"\s+", "", (status or "").strip().lower())


def is_excluded_open_count_status(status):
    text = normalize_status_key(status)
    return any(keyword in text for keyword in OPEN_COUNT_EXCLUDED_STATUS_KEYWORDS)


def is_hidden_project_status(status):
    text = re.sub(r"\s+", " ", status or "").strip().lower()
    return any(text == hidden.lower() for hidden in HIDDEN_PROJECT_STATUSES)


def visible_projects(projects):
    return [project for project in projects if not is_hidden_project_status(project.get("status"))]


def first_number(props, names):
    for name in names:
        value = prop_value(props, name)
        if value not in ("", None):
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def tc_count_value(props):
    value = first_number(props, TC_COUNT_PROPERTIES)
    if value is None or value <= 0:
        return 1
    return value


def tc_progress_value(props, fallback):
    value = first_number(props, TC_PROGRESS_PROPERTIES)
    return fallback if value is None else as_ratio(value)


def calculate_tc_metrics(project_id, parent_progress):
    databases = discover_child_databases(project_id)
    total_cases = 0.0
    executed_cases = 0.0
    database_summaries = []

    for database in databases:
        try:
            rows = query_database(database["id"])
        except Exception as exc:
            database_summaries.append(
                {
                    "id": database["id"],
                    "title": database["title"],
                    "rows": 0,
                    "caseCount": 0,
                    "executedCases": 0,
                    "error": str(exc),
                }
            )
            continue
        db_total = 0.0
        db_executed = 0.0
        for row in rows:
            props = row.get("properties", {})
            case_count = tc_count_value(props)
            progress = tc_progress_value(props, parent_progress)
            db_total += case_count
            db_executed += case_count * progress
        total_cases += db_total
        executed_cases += db_executed
        database_summaries.append(
            {
                "id": database["id"],
                "title": database["title"],
                "rows": len(rows),
                "caseCount": round(db_total),
                "executedCases": round(db_executed),
            }
        )

    if total_cases <= 0:
        return {
            "testCaseBase": 0,
            "executedCases": 0,
            "progress": parent_progress,
            "tcDatabases": database_summaries,
            "tcCountSource": "none",
        }

    return {
        "testCaseBase": round(total_cases),
        "executedCases": round(executed_cases),
        "progress": clamp(executed_cases / total_cases),
        "tcDatabases": database_summaries,
        "tcCountSource": "notion_child_databases",
    }


def load_projects():
    projects = []
    for category, database_id in TC_DATABASE_IDS:
        for page in query_database(database_id):
            props = page.get("properties", {})
            raw_name = prop_value(props, "이름")
            if not raw_name:
                continue
            status = prop_value(props, "상태")
            if is_hidden_project_status(status):
                continue
            projects.append(
                {
                    "id": page["id"],
                    "category": category,
                    "name": raw_name.strip(),
                    "project": normalize_project_name(raw_name),
                    "key": match_key(raw_name),
                    "progress": as_ratio(prop_value(props, "진행율")),
                    "status": status,
                    "date": prop_value(props, "날짜"),
                    "url": page.get("url", ""),
                    "lastEditedTime": page.get("last_edited_time", ""),
                }
            )
    return projects


def load_project(project_id):
    for project in load_projects():
        if project["id"] == project_id:
            return project
    raise ValueError("선택한 프로젝트를 찾을 수 없습니다.")


def load_issues():
    issues = []
    for page in query_database(ISSUE_DATABASE_ID):
        props = page.get("properties", {})
        target = prop_value(props, "목표버전")
        issues.append(
            {
                "id": page["id"],
                "title": prop_value(props, "결함 요약"),
                "target": target,
                "key": match_key(target),
                "status": prop_value(props, "상태"),
                "severity": prop_value(props, "심각도"),
                "priority": prop_value(props, "우선순위"),
                "url": page.get("url", ""),
            }
        )
    return issues


def issue_matches_project(issue_key, project_key):
    if not issue_key or not project_key:
        return False
    return issue_key == project_key or issue_key in project_key or project_key in issue_key


def calculate_project_hqi(project, issues):
    tc_metrics = calculate_tc_metrics(project["id"], project["progress"])
    related = [issue for issue in issues if issue_matches_project(issue["key"], project["key"])]
    bug_count = len(related)
    fixed_count = sum(1 for issue in related if is_done_status(issue["status"]))
    open_bug_count = sum(
        1
        for issue in related
        if not is_done_status(issue["status"]) and not is_excluded_open_count_status(issue["status"])
    )
    total_cases = tc_metrics["testCaseBase"]
    executed_cases = tc_metrics["executedCases"]
    denominator = max(1, executed_cases)
    tpr = tc_metrics["progress"]
    bor = 1.0 if bug_count == 0 else clamp(1 - (bug_count / denominator))
    bfr = 1.0 if bug_count == 0 else clamp(fixed_count / bug_count)
    dqs = (bor + bfr) / 2
    distance = math.sqrt((tpr - 1) ** 2 + (dqs - 1) ** 2)
    hqi = clamp(1 - (distance / math.sqrt(2)))
    severity_counts = {}
    for issue in related:
        severity = issue["severity"] or "미지정"
        severity_counts[severity] = severity_counts.get(severity, 0) + 1
    return {
        **project,
        "testCaseBase": total_cases,
        "executedCases": executed_cases,
        "tcCountSource": tc_metrics["tcCountSource"],
        "tcDatabases": tc_metrics["tcDatabases"],
        "bugCount": bug_count,
        "fixedCount": fixed_count,
        "openBugCount": open_bug_count,
        "TPR": round(tpr, 4),
        "BOR": round(bor, 4),
        "BFR": round(bfr, 4),
        "DQS": round(dqs, 4),
        "HQI": round(hqi, 4),
        "score": round(hqi * 100, 1),
        "severityCounts": severity_counts,
        "issues": related[:20],
    }


def calculate_hqi():
    projects = visible_projects(load_projects())
    issues = load_issues()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda project: calculate_project_hqi(project, issues), projects))
    results.sort(key=lambda item: item["score"])
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "formula": {
            "TPR": "진행율",
            "BOR": "1 - bugCount / executedCases",
            "BFR": "fixedBugCount / bugCount",
            "DQS": "(BOR + BFR) / 2",
            "HQI": "1 - sqrt((TPR - 1)^2 + (DQS - 1)^2) / sqrt(2)",
        },
        "projects": results,
        "summary": {
            "projectCount": len(results),
            "issueCount": len(issues),
            "testCaseCount": sum(r["testCaseBase"] for r in results),
            "executedCaseCount": sum(r["executedCases"] for r in results),
            "averageScore": round(sum(r["score"] for r in results) / len(results), 1) if results else 0,
            "lowestScore": results[0]["score"] if results else 0,
            "highestScore": results[-1]["score"] if results else 0,
        },
    }


def hqi_payload(projects, source="stored"):
    projects = sorted(visible_projects(projects), key=lambda item: item.get("score", 0))
    regular_trend = regular_update_trend(projects)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "projects": projects,
        "regularTrend": regular_trend,
        "summary": {
            "projectCount": len(projects),
            "issueCount": sum(r.get("bugCount", 0) for r in projects),
            "testCaseCount": sum(r.get("testCaseBase", 0) for r in projects),
            "executedCaseCount": sum(r.get("executedCases", 0) for r in projects),
            "averageScore": round(sum(r.get("score", 0) for r in projects) / len(projects), 1) if projects else 0,
            "lowestScore": projects[0]["score"] if projects else 0,
            "highestScore": projects[-1]["score"] if projects else 0,
        },
    }


def parse_version_project(project):
    match = re.fullmatch(r"5\.(\d+)(?:\.(\d+))?", project.get("project", "").strip())
    if not match or project.get("category") != "정기 업데이트":
        return None
    minor = int(match.group(1))
    patch = int(match.group(2) or 0)
    if minor < 18:
        return None
    return (minor, patch)


def regular_update_trend(projects):
    trend = []
    for project in projects:
        version = parse_version_project(project)
        if version is None:
            continue
        trend.append(
            {
                "project": project["project"],
                "versionKey": version,
                "score": project["score"],
                "TPR": project["TPR"],
                "DQS": project["DQS"],
                "bugCount": project["bugCount"],
                "testCaseBase": project["testCaseBase"],
                "executedCases": project["executedCases"],
            }
        )
    trend.sort(key=lambda item: item["versionKey"])
    for item in trend:
        item.pop("versionKey", None)
    return trend


def get_hqi(force_refresh=False):
    now = time.time()
    if (
        not force_refresh
        and HQI_CACHE["data"] is not None
        and now - HQI_CACHE["created"] < HQI_CACHE_TTL_SECONDS
    ):
        data = dict(HQI_CACHE["data"])
        data["cache"] = {
            "hit": True,
            "createdAt": datetime.fromtimestamp(HQI_CACHE["created"], timezone.utc).isoformat(),
            "ttlSeconds": HQI_CACHE_TTL_SECONDS,
        }
        return data

    data = calculate_hqi()
    HQI_CACHE["created"] = now
    HQI_CACHE["data"] = data
    data = dict(data)
    data["cache"] = {"hit": False, "ttlSeconds": HQI_CACHE_TTL_SECONDS}
    return data


def get_saved_hqi():
    return hqi_payload(load_saved_results(), "stored")


def calculate_and_store_project(project_id, force=False):
    project = load_project(project_id)
    issue_db = notion_request(f"/databases/{ISSUE_DATABASE_ID}")
    issue_db_last_edited = issue_db.get("last_edited_time", "")
    saved = load_saved_result(project_id)
    if (
        saved
        and not force
        and saved["project_last_edited"] == project["lastEditedTime"]
        and saved["issue_db_last_edited"] == issue_db_last_edited
    ):
        return {"updated": False, "reason": "no_changes", "project": saved["data"]}

    issues = load_issues()
    result = calculate_project_hqi(project, issues)
    result = save_result(result, project["lastEditedTime"], issue_db_last_edited)
    HQI_CACHE["data"] = None
    return {"updated": True, "reason": "calculated", "project": result}


def calculate_and_store_all_projects(force=False):
    projects = visible_projects(load_projects())
    issue_db = notion_request(f"/databases/{ISSUE_DATABASE_ID}")
    issue_db_last_edited = issue_db.get("last_edited_time", "")
    needs_calculation = []
    reused = []

    for project in projects:
        saved = load_saved_result(project["id"])
        if (
            saved
            and not force
            and saved["project_last_edited"] == project["lastEditedTime"]
            and saved["issue_db_last_edited"] == issue_db_last_edited
        ):
            reused.append(saved["data"])
            continue
        needs_calculation.append(project)

    calculated = []
    errors = []
    if needs_calculation:
        issues = load_issues()
        for project in needs_calculation:
            try:
                result = calculate_project_hqi(project, issues)
                calculated.append(save_result(result, project["lastEditedTime"], issue_db_last_edited))
            except Exception as exc:
                traceback.print_exc()
                errors.append(
                    {
                        "projectId": project["id"],
                        "project": project["project"],
                        "message": str(exc) or exc.__class__.__name__,
                    }
                )

    HQI_CACHE["data"] = None
    return {
        "updatedCount": len(calculated),
        "reusedCount": len(reused),
        "errorCount": len(errors),
        "errors": errors,
        "totalCount": len(projects),
        "projects": calculated + reused,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/hqi":
                self.send_json(get_saved_hqi())
                return
            if parsed.path == "/api/projects":
                self.send_json({"projects": load_projects()})
                return
            if parsed.path in ("/", "/index.html"):
                self.send_file("index.html", "text/html; charset=utf-8")
                return
            if parsed.path == "/embed.html":
                self.send_file("embed.html", "text/html; charset=utf-8")
                return
            if parsed.path == "/styles.css":
                self.send_file("styles.css", "text/css; charset=utf-8")
                return
            if parsed.path == "/app.js":
                self.send_file("app.js", "application/javascript; charset=utf-8")
                return
            if parsed.path == "/embed.js":
                self.send_file("embed.js", "application/javascript; charset=utf-8")
                return
            if parsed.path == "/embed-data.json":
                self.send_file("embed-data.json", "application/json; charset=utf-8")
                return
            self.send_json({"message": "Not found"}, 404)
        except Exception as exc:
            self.send_exception(exc)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/calculate":
                payload = read_json_body(self)
                project_id = payload.get("projectId")
                if not project_id:
                    self.send_json({"message": "projectId가 필요합니다."}, 400)
                    return
                result = calculate_and_store_project(project_id, bool(payload.get("force")))
                self.send_json({**result, "dashboard": get_saved_hqi()})
                return
            if parsed.path == "/api/calculate-all":
                payload = read_json_body(self)
                result = calculate_and_store_all_projects(bool(payload.get("force")))
                self.send_json({**result, "dashboard": get_saved_hqi()})
                return
            self.send_json({"message": "Not found"}, 404)
        except Exception as exc:
            self.send_exception(exc)

    def send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_file(self, filename, content_type):
        path = Path(__file__).with_name(filename)
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_exception(self, exc):
        traceback.print_exc()
        message = str(exc) or exc.__class__.__name__
        self.send_json({"message": message, "errorType": exc.__class__.__name__}, 500)

    def log_message(self, fmt, *args):
        print(fmt % args)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"HQI app running at http://0.0.0.0:{port}")
    server.serve_forever()
