import csv
import io
import os
import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import pymysql
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

NAME_MAPPING: Dict[str, str] = {
    "补充": "Supplement",
    "仓单": "Warehouse Receipt",
    "黑色": "Black",
    "农油": "Agricultural Oils",
    "全量": "Full Volume",
    "有色": "Non-ferrous Metals",
}

CANDIDATE_COLUMNS: Dict[str, List[str]] = {
    "indicator_code": ["indicator_code", "indicator code", "indicatorcode", "code", "指标代码", "symbol"],
    "indicator_name": ["indicator_name", "indicator name", "indicatorname", "name", "指标名称", "指标名"],
    "value": ["value", "数值", "值", "指标值", "data_value", "price", "close"],
    "unit": ["unit", "单位", "uom"],
    "frequency": ["frequency", "freq", "频率", "周期"],
    "datetime": ["datetime", "date_time", "date", "time", "日期", "时间", "trade_date", "dt"],
}

REQUIRED_FIELDS = ["indicator_code", "indicator_name", "value", "datetime"]

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIST = os.path.join(BASE_DIR, "frontend", "dist")
FRONTEND_ASSETS = os.path.join(FRONTEND_DIST, "assets")
load_dotenv(os.path.join(BASE_DIR, ".env"))


def normalize_identifier(text: str) -> str:
    return re.sub(r"[\s_\-`\"'./]", "", str(text).strip().lower())


def quote_identifier(name: str) -> str:
    return f"`{str(name).replace('`', '``')}`"


def parse_float(value) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def to_text(value) -> str:
    if value is None:
        return ""
    return str(value)


def db_config() -> Dict[str, object]:
    return {
        "host": os.getenv("DB_HOST", "10.10.10.120"),
        "user": os.getenv("DB_USER", "root"),
        "password": os.getenv("DB_PASSWORD", "eiNg6pie"),
        "database": os.getenv("DB_NAME", "futures"),
        "port": int(os.getenv("DB_PORT", "3306")),
    }


def get_connection():
    cfg = db_config()
    return pymysql.connect(
        host=cfg["host"],
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        port=int(cfg["port"]),
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )


def fetch_all_tables(conn) -> List[str]:
    with conn.cursor() as cursor:
        cursor.execute("SHOW TABLES")
        rows = cursor.fetchall()
    return [list(row.values())[0] for row in rows]


def resolve_table_name(display_name_cn: str, tables_in_db: List[str]) -> Optional[str]:
    if display_name_cn in tables_in_db:
        return display_name_cn

    en_name = NAME_MAPPING.get(display_name_cn)
    if not en_name:
        return None

    candidates = {
        display_name_cn,
        en_name,
        en_name.lower(),
        en_name.upper(),
        en_name.replace(" ", "_"),
        en_name.replace(" ", ""),
        en_name.replace("-", "_"),
    }

    normalized_map = {normalize_identifier(name): name for name in tables_in_db}
    for candidate in candidates:
        key = normalize_identifier(candidate)
        if key in normalized_map:
            return normalized_map[key]

    return None


def fetch_columns(conn, table_name: str) -> List[str]:
    with conn.cursor() as cursor:
        cursor.execute(f"SHOW COLUMNS FROM {quote_identifier(table_name)}")
        rows = cursor.fetchall()
    return [row["Field"] for row in rows]


def build_column_mapping(columns: List[str]) -> Tuple[Dict[str, Optional[str]], List[str]]:
    mapping: Dict[str, Optional[str]] = {}
    normalized_to_original = {normalize_identifier(col): col for col in columns}

    for target_field, candidate_list in CANDIDATE_COLUMNS.items():
        found = None
        for candidate in candidate_list:
            key = normalize_identifier(candidate)
            if key in normalized_to_original:
                found = normalized_to_original[key]
                break

        if found is None:
            for col in columns:
                col_norm = normalize_identifier(col)
                for candidate in candidate_list:
                    cand_norm = normalize_identifier(candidate)
                    if cand_norm in col_norm or col_norm in cand_norm:
                        found = col
                        break
                if found is not None:
                    break

        mapping[target_field] = found

    missing_required = [field for field in REQUIRED_FIELDS if mapping.get(field) is None]
    return mapping, missing_required


def get_table_context(conn, table_cn: str) -> Tuple[str, Dict[str, str]]:
    tables = fetch_all_tables(conn)
    table_name = resolve_table_name(table_cn, tables)
    if not table_name:
        raise HTTPException(status_code=404, detail=f"未找到数据表: {table_cn}")

    columns = fetch_columns(conn, table_name)
    col_map, missing = build_column_mapping(columns)
    if missing:
        raise HTTPException(status_code=400, detail=f"字段映射缺失: {', '.join(missing)}")

    return table_name, col_map  # type: ignore[return-value]


def build_where_clause(col_map: Dict[str, str], payload) -> Tuple[str, List[object]]:
    where_clauses = ["1=1"]
    params: List[object] = []

    indicator_code = to_text(getattr(payload, "indicator_code", "")).strip()
    indicator_name = to_text(getattr(payload, "indicator_name", "")).strip()
    indicator_code_like = to_text(getattr(payload, "indicator_code_like", "")).strip()
    indicator_name_like = to_text(getattr(payload, "indicator_name_like", "")).strip()

    if indicator_code and indicator_code != "全部":
        where_clauses.append(f"CAST({quote_identifier(col_map['indicator_code'])} AS CHAR) = %s")
        params.append(indicator_code)

    if indicator_name and indicator_name != "全部":
        where_clauses.append(f"CAST({quote_identifier(col_map['indicator_name'])} AS CHAR) = %s")
        params.append(indicator_name)

    if indicator_code_like:
        where_clauses.append(f"CAST({quote_identifier(col_map['indicator_code'])} AS CHAR) LIKE %s")
        params.append(f"%{indicator_code_like}%")

    if indicator_name_like:
        where_clauses.append(f"CAST({quote_identifier(col_map['indicator_name'])} AS CHAR) LIKE %s")
        params.append(f"%{indicator_name_like}%")

    date_start = to_text(getattr(payload, "date_start", "")).strip()
    date_end = to_text(getattr(payload, "date_end", "")).strip()

    if date_start:
        where_clauses.append(f"{quote_identifier(col_map['datetime'])} >= %s")
        params.append(date_start)

    if date_end:
        end_exclusive = datetime.strptime(date_end, "%Y-%m-%d") + timedelta(days=1)
        where_clauses.append(f"{quote_identifier(col_map['datetime'])} < %s")
        params.append(end_exclusive.strftime("%Y-%m-%d"))

    enable_value_filter = bool(getattr(payload, "enable_value_filter", False))
    value_min = parse_float(getattr(payload, "value_min", None))
    value_max = parse_float(getattr(payload, "value_max", None))
    if enable_value_filter and value_min is not None and value_max is not None:
        where_clauses.append(
            f"CAST({quote_identifier(col_map['value'])} AS DECIMAL(30,10)) BETWEEN %s AND %s"
        )
        params.extend([value_min, value_max])

    return " AND ".join(where_clauses), params


def row_to_output(row: Dict[str, object]) -> Dict[str, object]:
    dt = row.get("datetime")
    if isinstance(dt, datetime):
        dt_out = dt.strftime("%Y-%m-%d")
    else:
        dt_out = to_text(dt)

    return {
        "indicator_code": to_text(row.get("indicator_code")),
        "indicator_name": to_text(row.get("indicator_name")),
        "value": parse_float(row.get("value")),
        "unit": to_text(row.get("unit")),
        "frequency": to_text(row.get("frequency")),
        "datetime": dt_out,
    }


def compute_stats(rows: List[Dict[str, object]]) -> Dict[str, Optional[float]]:
    vals = [parse_float(r.get("value")) for r in rows]
    nums = sorted([v for v in vals if v is not None])
    if not nums:
        return {"avg": None, "min": None, "max": None, "median": None, "std": None}

    n = len(nums)
    avg = sum(nums) / n
    min_v = nums[0]
    max_v = nums[-1]

    if n % 2 == 1:
        median = nums[n // 2]
    else:
        median = (nums[n // 2 - 1] + nums[n // 2]) / 2

    if n == 1:
        std = 0.0
    else:
        variance = sum((x - avg) ** 2 for x in nums) / n
        std = variance ** 0.5

    return {"avg": avg, "min": min_v, "max": max_v, "median": median, "std": std}


class QueryPayload(BaseModel):
    table_cn: str = Field(..., description="中文表名")
    indicator_name: Optional[str] = None
    indicator_code: Optional[str] = None
    indicator_name_like: Optional[str] = None
    indicator_code_like: Optional[str] = None
    date_start: Optional[str] = None
    date_end: Optional[str] = None
    enable_value_filter: bool = False
    value_min: Optional[float] = None
    value_max: Optional[float] = None
    limit: int = 5000


app = FastAPI(title="Ganglian Data API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "gangliandata-react"}


@app.get("/api/tables")
def api_tables():
    conn = get_connection()
    try:
        tables = fetch_all_tables(conn)
        data = []
        for cn, en in NAME_MAPPING.items():
            resolved = resolve_table_name(cn, tables)
            if resolved:
                data.append({"cn": cn, "en": en, "table_name": resolved})
        return {"tables": data}
    finally:
        conn.close()


@app.get("/api/filter-meta")
def api_filter_meta(table_cn: str):
    conn = get_connection()
    try:
        table_name, col_map = get_table_context(conn, table_cn)
        with conn.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT
                  MIN({quote_identifier(col_map['datetime'])}) AS min_dt,
                  MAX({quote_identifier(col_map['datetime'])}) AS max_dt,
                  MIN({quote_identifier(col_map['value'])}) AS min_val,
                  MAX({quote_identifier(col_map['value'])}) AS max_val,
                  COUNT(*) AS total_count
                FROM {quote_identifier(table_name)}
                """
            )
            profile = cursor.fetchone() or {}

            cursor.execute(
                f"""
                SELECT DISTINCT CAST({quote_identifier(col_map['indicator_name'])} AS CHAR) AS opt
                FROM {quote_identifier(table_name)}
                WHERE {quote_identifier(col_map['indicator_name'])} IS NOT NULL
                  AND CAST({quote_identifier(col_map['indicator_name'])} AS CHAR) <> ''
                ORDER BY opt
                LIMIT 3000
                """
            )
            names = [to_text(r.get("opt")) for r in cursor.fetchall()]

            cursor.execute(
                f"""
                SELECT DISTINCT CAST({quote_identifier(col_map['indicator_code'])} AS CHAR) AS opt
                FROM {quote_identifier(table_name)}
                WHERE {quote_identifier(col_map['indicator_code'])} IS NOT NULL
                  AND CAST({quote_identifier(col_map['indicator_code'])} AS CHAR) <> ''
                ORDER BY opt
                LIMIT 3000
                """
            )
            codes = [to_text(r.get("opt")) for r in cursor.fetchall()]

        return {
            "table_cn": table_cn,
            "table_name": table_name,
            "indicator_names": names,
            "indicator_codes": codes,
            "date_min": to_text(profile.get("min_dt")),
            "date_max": to_text(profile.get("max_dt")),
            "value_min": parse_float(profile.get("min_val")),
            "value_max": parse_float(profile.get("max_val")),
            "total_count": int(profile.get("total_count") or 0),
        }
    finally:
        conn.close()


@app.post("/api/query")
def api_query(payload: QueryPayload):
    conn = get_connection()
    try:
        table_name, col_map = get_table_context(conn, payload.table_cn)
        where_sql, params = build_where_clause(col_map, payload)

        safe_limit = max(100, min(int(payload.limit), 30000))

        with conn.cursor() as cursor:
            cursor.execute(
                f"SELECT COUNT(*) AS total_count FROM {quote_identifier(table_name)} WHERE {where_sql}",
                params,
            )
            total_count = int((cursor.fetchone() or {}).get("total_count") or 0)

            select_sql = f"""
                SELECT
                  {quote_identifier(col_map['indicator_code'])} AS indicator_code,
                  {quote_identifier(col_map['indicator_name'])} AS indicator_name,
                  {quote_identifier(col_map['value'])} AS value,
                  {quote_identifier(col_map['datetime'])} AS datetime,
                  {quote_identifier(col_map['unit']) if col_map.get('unit') else 'NULL'} AS unit,
                  {quote_identifier(col_map['frequency']) if col_map.get('frequency') else 'NULL'} AS frequency
                FROM {quote_identifier(table_name)}
                WHERE {where_sql}
                ORDER BY {quote_identifier(col_map['datetime'])} DESC
                LIMIT {safe_limit}
            """
            cursor.execute(select_sql, params)
            rows = [row_to_output(r) for r in cursor.fetchall()]

        stats = compute_stats(rows)
        return {
            "table_cn": payload.table_cn,
            "table_name": table_name,
            "total_count": total_count,
            "row_count": len(rows),
            "limit": safe_limit,
            "truncated": total_count > len(rows),
            "stats": stats,
            "rows": rows,
        }
    finally:
        conn.close()


@app.post("/api/export")
def api_export(payload: QueryPayload):
    conn = get_connection()
    try:
        table_name, col_map = get_table_context(conn, payload.table_cn)
        where_sql, params = build_where_clause(col_map, payload)

        with conn.cursor() as cursor:
            select_sql = f"""
                SELECT
                  {quote_identifier(col_map['indicator_code'])} AS indicator_code,
                  {quote_identifier(col_map['indicator_name'])} AS indicator_name,
                  {quote_identifier(col_map['value'])} AS value,
                  {quote_identifier(col_map['datetime'])} AS datetime,
                  {quote_identifier(col_map['unit']) if col_map.get('unit') else 'NULL'} AS unit,
                  {quote_identifier(col_map['frequency']) if col_map.get('frequency') else 'NULL'} AS frequency
                FROM {quote_identifier(table_name)}
                WHERE {where_sql}
                ORDER BY {quote_identifier(col_map['datetime'])} DESC
            """
            cursor.execute(select_sql, params)
            rows = [row_to_output(r) for r in cursor.fetchall()]

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["indicator code", "indicator name", "value", "unit", "frequency", "datetime"])
        for r in rows:
            writer.writerow(
                [
                    r["indicator_code"],
                    r["indicator_name"],
                    r["value"] if r["value"] is not None else "",
                    r["unit"],
                    r["frequency"],
                    r["datetime"],
                ]
            )

        csv_text = output.getvalue()
        output.close()

        filename = f"{payload.table_cn}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        return StreamingResponse(
            iter([csv_text]),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )
    finally:
        conn.close()


if os.path.isdir(FRONTEND_ASSETS):
    app.mount("/assets", StaticFiles(directory=FRONTEND_ASSETS), name="assets")


@app.get("/")
def root_page():
    index_file = os.path.join(FRONTEND_DIST, "index.html")
    if os.path.isfile(index_file):
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="前端未构建，请先运行 npm run build")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")

    target = os.path.join(FRONTEND_DIST, full_path)
    if os.path.isfile(target):
        return FileResponse(target)

    index_file = os.path.join(FRONTEND_DIST, "index.html")
    if os.path.isfile(index_file):
        return FileResponse(index_file)

    raise HTTPException(status_code=404, detail="前端未构建，请先运行 npm run build")
