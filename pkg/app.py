import os
import re
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

import pandas as pd
import plotly.express as px
import pymysql
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

NAME_MAPPING: Dict[str, str] = {
    "补充": "Supplement",
    "仓单": "Warehouse Receipt",
    "黑色": "Black",
    "农油": "Agricultural Oils",
    "全量": "Full Volume",
    "有色": "Non-ferrous Metals",
}

CANDIDATE_COLUMNS: Dict[str, List[str]] = {
    "indicator_code": [
        "indicator_code",
        "indicator code",
        "indicatorcode",
        "code",
        "指标代码",
        "指标编码",
        "index_code",
        "symbol",
    ],
    "indicator_name": [
        "indicator_name",
        "indicator name",
        "indicatorname",
        "name",
        "指标名称",
        "指标名",
        "指标",
    ],
    "value": ["value", "数值", "值", "指标值", "data_value", "price", "close"],
    "unit": ["unit", "单位", "uom"],
    "frequency": ["frequency", "freq", "频率", "周期"],
    "datetime": [
        "datetime",
        "date_time",
        "date",
        "time",
        "日期",
        "时间",
        "交易日期",
        "trade_date",
        "dt",
    ],
}

REQUIRED_FIELDS = ["indicator_code", "indicator_name", "value", "datetime"]
OPTIONAL_FIELDS = ["unit", "frequency"]


def normalize_identifier(text: str) -> str:
    return re.sub(r"[\s_\-`\"'./]", "", str(text).strip().lower())


def quote_identifier(name: str) -> str:
    return f"`{str(name).replace('`', '``')}`"


def safe_float(value) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def format_number(value: float) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    if abs(value) >= 1000:
        return f"{value:,.2f}"
    return f"{value:.4f}"


def db_config() -> Dict[str, object]:
    return {
        "host": os.getenv("DB_HOST", "10.10.10.120"),
        "user": os.getenv("DB_USER", "root"),
        "password": os.getenv("DB_PASSWORD", "eiNg6pie"),
        "database": os.getenv("DB_NAME", "futures"),
        "port": int(os.getenv("DB_PORT", "3306")),
    }


def config_signature() -> Tuple[Tuple[str, str], ...]:
    cfg = db_config()
    return tuple(sorted((k, str(v)) for k, v in cfg.items()))


@st.cache_resource
def get_connection(sig: Tuple[Tuple[str, str], ...]):
    cfg = dict(sig)
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


def live_connection(sig: Tuple[Tuple[str, str], ...]):
    conn = get_connection(sig)
    conn.ping(reconnect=True)
    return conn


@st.cache_data(ttl=60)
def fetch_all_tables(sig: Tuple[Tuple[str, str], ...]) -> List[str]:
    conn = live_connection(sig)
    with conn.cursor() as cursor:
        cursor.execute("SHOW TABLES")
        rows = cursor.fetchall()
    return [list(row.values())[0] for row in rows]


def resolve_table_name(display_name_cn: str, tables_in_db: List[str]) -> Optional[str]:
    if display_name_cn in tables_in_db:
        return display_name_cn

    en_name = NAME_MAPPING[display_name_cn]
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


@st.cache_data(ttl=120)
def fetch_columns(sig: Tuple[Tuple[str, str], ...], table_name: str) -> List[str]:
    conn = live_connection(sig)
    sql = f"SHOW COLUMNS FROM {quote_identifier(table_name)}"
    with conn.cursor() as cursor:
        cursor.execute(sql)
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


@st.cache_data(ttl=120)
def fetch_profile(
    sig: Tuple[Tuple[str, str], ...],
    table_name: str,
    col_map_items: Tuple[Tuple[str, Optional[str]], ...],
) -> Dict[str, object]:
    col_map = dict(col_map_items)
    value_col = quote_identifier(col_map["value"])
    datetime_col = quote_identifier(col_map["datetime"])

    sql = f"""
        SELECT
            MIN({datetime_col}) AS min_dt,
            MAX({datetime_col}) AS max_dt,
            MIN({value_col}) AS min_val,
            MAX({value_col}) AS max_val,
            COUNT(*) AS total_count
        FROM {quote_identifier(table_name)}
    """
    conn = live_connection(sig)
    with conn.cursor() as cursor:
        cursor.execute(sql)
        row = cursor.fetchone()
    return row or {}


@st.cache_data(ttl=300)
def fetch_distinct_field_options(
    sig: Tuple[Tuple[str, str], ...],
    table_name: str,
    col_map_items: Tuple[Tuple[str, Optional[str]], ...],
    target_field: str,
    limit: int = 3000,
) -> List[str]:
    col_map = dict(col_map_items)
    source_col = col_map.get(target_field)
    if not source_col:
        return []

    source_col_q = quote_identifier(source_col)
    safe_limit = max(1, min(int(limit), 10000))
    sql = f"""
        SELECT DISTINCT CAST({source_col_q} AS CHAR) AS opt
        FROM {quote_identifier(table_name)}
        WHERE {source_col_q} IS NOT NULL
          AND CAST({source_col_q} AS CHAR) <> ''
        ORDER BY opt
        LIMIT {safe_limit}
    """

    conn = live_connection(sig)
    with conn.cursor() as cursor:
        cursor.execute(sql)
        rows = cursor.fetchall()

    return [str(row["opt"]) for row in rows if row.get("opt") is not None]


@st.cache_data(ttl=60)
def fetch_filtered_data(
    sig: Tuple[Tuple[str, str], ...],
    table_name: str,
    col_map_items: Tuple[Tuple[str, Optional[str]], ...],
    indicator_code_kw: str,
    indicator_name_kw: str,
    date_start_iso: str,
    date_end_iso: str,
    apply_value_filter: bool,
    value_min: Optional[float],
    value_max: Optional[float],
) -> pd.DataFrame:
    col_map = dict(col_map_items)

    select_parts = [
        f"{quote_identifier(col_map['indicator_code'])} AS indicator_code",
        f"{quote_identifier(col_map['indicator_name'])} AS indicator_name",
        f"{quote_identifier(col_map['value'])} AS value",
        f"{quote_identifier(col_map['datetime'])} AS datetime",
    ]

    if col_map.get("unit"):
        select_parts.append(f"{quote_identifier(col_map['unit'])} AS unit")
    else:
        select_parts.append("NULL AS unit")

    if col_map.get("frequency"):
        select_parts.append(f"{quote_identifier(col_map['frequency'])} AS frequency")
    else:
        select_parts.append("NULL AS frequency")

    where_clauses = ["1=1"]
    params: List[object] = []

    if indicator_code_kw:
        where_clauses.append(f"CAST({quote_identifier(col_map['indicator_code'])} AS CHAR) LIKE %s")
        params.append(f"%{indicator_code_kw}%")

    if indicator_name_kw:
        where_clauses.append(f"CAST({quote_identifier(col_map['indicator_name'])} AS CHAR) LIKE %s")
        params.append(f"%{indicator_name_kw}%")

    if date_start_iso:
        where_clauses.append(f"{quote_identifier(col_map['datetime'])} >= %s")
        params.append(date_start_iso)

    if date_end_iso:
        end_exclusive = datetime.strptime(date_end_iso, "%Y-%m-%d") + timedelta(days=1)
        where_clauses.append(f"{quote_identifier(col_map['datetime'])} < %s")
        params.append(end_exclusive.strftime("%Y-%m-%d"))

    if apply_value_filter and value_min is not None and value_max is not None:
        where_clauses.append(
            f"CAST({quote_identifier(col_map['value'])} AS DECIMAL(30, 10)) BETWEEN %s AND %s"
        )
        params.extend([value_min, value_max])

    sql = f"""
        SELECT {", ".join(select_parts)}
        FROM {quote_identifier(table_name)}
        WHERE {' AND '.join(where_clauses)}
        ORDER BY {quote_identifier(col_map['datetime'])} DESC
    """

    conn = live_connection(sig)
    with conn.cursor() as cursor:
        cursor.execute(sql, params)
        rows = cursor.fetchall()

    df = pd.DataFrame(rows)
    expected_cols = ["indicator_code", "indicator_name", "value", "datetime", "unit", "frequency"]
    for col in expected_cols:
        if col not in df.columns:
            df[col] = pd.NA
    df = df[expected_cols]

    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce")

    for optional_col in ["unit", "frequency"]:
        if optional_col not in df.columns:
            df[optional_col] = ""

    return df


def stat_card(container, title: str, value: str):
    container.markdown(
        f"""
        <div class=\"metric-card\">
          <div class=\"metric-title\">{title}</div>
          <div class=\"metric-value\">{value}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def apply_page_style():
    st.markdown(
        """
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=IBM+Plex+Sans+SC:wght@400;600;700&display=swap');

        :root {
            --bg-a: #f4fbff;
            --bg-b: #fefaf2;
            --text: #142032;
            --muted: #6b7a90;
            --card: #ffffff;
            --line: #dce6f4;
            --accent: #0f7ae5;
            --accent-2: #17a2a4;
        }

        html, body, [class*="css"] {
            font-family: 'Manrope', 'IBM Plex Sans SC', sans-serif;
            color: var(--text);
        }

        .stApp {
            background:
              radial-gradient(circle at 12% 12%, #dbf2ff 0%, transparent 42%),
              radial-gradient(circle at 88% 8%, #ffeec8 0%, transparent 38%),
              linear-gradient(125deg, var(--bg-a), var(--bg-b));
        }

        .metric-card {
            background: linear-gradient(160deg, #ffffff 0%, #f8fbff 100%);
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 12px 14px;
            box-shadow: 0 6px 14px rgba(20, 32, 50, 0.05);
            min-height: 88px;
        }

        .metric-title {
            color: var(--muted);
            font-size: 0.82rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }

        .metric-value {
            color: var(--text);
            font-size: 1.2rem;
            font-weight: 800;
            line-height: 1.2;
        }

        .result-bar {
            background: linear-gradient(120deg, #ffffff, #f5fbff);
            border: 1px solid #d7e7f8;
            border-radius: 14px;
            padding: 12px 14px;
            margin: 6px 0 12px;
            box-shadow: 0 6px 14px rgba(20, 32, 50, 0.04);
        }

        .result-count {
            margin: 0;
            font-size: 1.02rem;
            font-weight: 700;
            color: #1a2a40;
        }

        .result-sub {
            margin: 6px 0 0;
            font-size: 0.88rem;
            color: #5f7390;
        }

        [data-testid="stSidebar"] {
            background:
              radial-gradient(circle at 15% 10%, #d9efff 0%, transparent 35%),
              linear-gradient(180deg, #eef7ff 0%, #ecf7f3 100%);
            border-right: 1px solid #d4e5f8;
        }

        [data-testid="stSidebar"] .stMarkdown h2 {
            font-size: 1.05rem;
            font-weight: 800;
            letter-spacing: 0.2px;
            color: #173054;
        }

        .sidebar-note {
            background: rgba(255, 255, 255, 0.78);
            border: 1px solid #d8e7f7;
            border-radius: 10px;
            padding: 8px 10px;
            color: #4f6788;
            font-size: 0.84rem;
            margin-bottom: 8px;
        }

        [data-testid="stSidebar"] [data-testid="stForm"] {
            background: rgba(255, 255, 255, 0.75);
            border: 1px solid #d7e5f6;
            border-radius: 14px;
            padding: 10px 10px 8px;
            box-shadow: 0 5px 12px rgba(20, 32, 50, 0.04);
        }

        [data-testid="stSidebar"] .stSelectbox > div,
        [data-testid="stSidebar"] .stDateInput > div,
        [data-testid="stSidebar"] .stMultiSelect > div,
        [data-testid="stSidebar"] .stSlider {
            border-radius: 10px;
        }

        [data-testid="stSidebar"] .stButton > button,
        [data-testid="stSidebar"] button[kind="primary"] {
            border-radius: 10px;
            font-weight: 700;
        }

        [data-testid="stMarkdownContainer"] h3 {
            color: #173459;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def main():
    st.set_page_config(page_title="Futures Multi-Table Dashboard", page_icon="📊", layout="wide")
    apply_page_style()

    sig = config_signature()

    if st.sidebar.button("刷新缓存"):
        st.cache_data.clear()
        st.cache_resource.clear()
        st.rerun()

    try:
        tables_in_db = fetch_all_tables(sig)
    except Exception as exc:
        st.error(f"数据库连接失败：{exc}")
        st.info("请检查 .env 中的数据库配置，确认服务器网络可达。")
        return

    resolved_tables = {cn: resolve_table_name(cn, tables_in_db) for cn in NAME_MAPPING.keys()}

    st.sidebar.header("🔍 查询条件")
    st.sidebar.markdown("<div class='sidebar-note'>当前筛选会作用在右侧所选数据表。</div>", unsafe_allow_html=True)

    available_tables_cn = [cn for cn in NAME_MAPPING.keys() if resolved_tables.get(cn)]
    if not available_tables_cn:
        st.error("数据库中没有可用的数据表。")
        return

    default_table_cn = "全量" if "全量" in available_tables_cn else available_tables_cn[0]
    if "active_tables_cn" not in st.session_state:
        st.session_state["active_tables_cn"] = [default_table_cn]
    if "last_query_params" not in st.session_state:
        st.session_state["last_query_params"] = None

    active_tables_cn = [cn for cn in st.session_state["active_tables_cn"] if cn in available_tables_cn]
    if not active_tables_cn:
        active_tables_cn = [default_table_cn]
    st.session_state["active_tables_cn"] = active_tables_cn

    st.subheader("🧾 数据表展示")
    current_active_cn = active_tables_cn[0]
    picked_table_cn = st.selectbox(
        "选择数据表（单选）",
        options=available_tables_cn,
        index=available_tables_cn.index(current_active_cn),
        format_func=lambda x: f"{x} / {NAME_MAPPING[x]}",
    )
    if picked_table_cn != current_active_cn:
        st.session_state["active_tables_cn"] = [picked_table_cn]
        st.session_state["last_query_params"] = None
        st.rerun()

    selected_tables_cn = [cn for cn in st.session_state.get("active_tables_cn", []) if cn in available_tables_cn]
    if not selected_tables_cn:
        st.warning("当前没有可展示的数据表，请重新选择。")
        return

    table_meta_list = []
    for cn in selected_tables_cn:
        table_name = resolved_tables.get(cn)
        if not table_name:
            st.warning(f"跳过 `{cn}`：数据库中未找到对应表。")
            continue
        try:
            columns = fetch_columns(sig, table_name)
        except Exception as exc:
            st.warning(f"跳过 `{cn}`：读取字段失败（{exc}）。")
            continue

        col_map, missing_fields = build_column_mapping(columns)
        if missing_fields:
            st.warning(f"跳过 `{cn}`：缺少必要字段映射（{', '.join(missing_fields)}）。")
            continue

        col_map_items = tuple(sorted(col_map.items()))
        table_meta_list.append(
            {
                "cn": cn,
                "en": NAME_MAPPING[cn],
                "table_name": table_name,
                "col_map_items": col_map_items,
                "profile": fetch_profile(sig, table_name, col_map_items),
            }
        )

    if not table_meta_list:
        st.error("已选数据表都无法读取，请检查字段结构。")
        return

    st.caption("当前展示数据表：" + "、".join([f"{meta['cn']} / {meta['en']}" for meta in table_meta_list]))

    indicator_name_set = set()
    indicator_code_set = set()
    min_date_candidates = []
    max_date_candidates = []
    min_value_candidates = []
    max_value_candidates = []

    for meta in table_meta_list:
        indicator_name_set.update(
            fetch_distinct_field_options(sig, meta["table_name"], meta["col_map_items"], "indicator_name")
        )
        indicator_code_set.update(
            fetch_distinct_field_options(sig, meta["table_name"], meta["col_map_items"], "indicator_code")
        )

        min_dt = pd.to_datetime(meta["profile"].get("min_dt"), errors="coerce")
        max_dt = pd.to_datetime(meta["profile"].get("max_dt"), errors="coerce")
        if pd.notna(min_dt):
            min_date_candidates.append(min_dt)
        if pd.notna(max_dt):
            max_date_candidates.append(max_dt)

        min_val = safe_float(meta["profile"].get("min_val"))
        max_val = safe_float(meta["profile"].get("max_val"))
        if min_val is not None:
            min_value_candidates.append(min_val)
        if max_val is not None:
            max_value_candidates.append(max_val)

    active_key = "|".join(sorted([meta["cn"] for meta in table_meta_list]))
    saved_params = st.session_state.get("last_query_params")
    if not saved_params or saved_params.get("active_key") != active_key:
        saved_params = None

    indicator_name_options = ["全部"] + sorted(indicator_name_set)
    indicator_code_options = ["全部"] + sorted(indicator_code_set)

    default_name_option = "全部"
    if saved_params and saved_params.get("indicator_name", "全部") in indicator_name_options:
        default_name_option = saved_params["indicator_name"]

    default_code_option = "全部"
    if saved_params and saved_params.get("indicator_code", "全部") in indicator_code_options:
        default_code_option = saved_params["indicator_code"]

    overall_start = None
    overall_end = None
    default_start = None
    default_end = None
    default_date_start_iso = ""
    default_date_end_iso = ""
    if min_date_candidates and max_date_candidates:
        overall_start = min(min_date_candidates).date()
        overall_end = max(max_date_candidates).date()
        default_start = overall_start
        default_end = overall_end
        if saved_params:
            saved_start = pd.to_datetime(saved_params.get("date_start_iso", ""), errors="coerce")
            saved_end = pd.to_datetime(saved_params.get("date_end_iso", ""), errors="coerce")
            if pd.notna(saved_start):
                default_start = saved_start.date()
            if pd.notna(saved_end):
                default_end = saved_end.date()
        if default_start < overall_start:
            default_start = overall_start
        if default_end > overall_end:
            default_end = overall_end
        if default_start > default_end:
            default_start, default_end = overall_start, overall_end
        default_date_start_iso = default_start.strftime("%Y-%m-%d")
        default_date_end_iso = default_end.strftime("%Y-%m-%d")

    overall_min_value = None
    overall_max_value = None
    default_apply_value = bool(saved_params.get("apply_value_filter", False)) if saved_params else False
    default_min_value = None
    default_max_value = None
    if min_value_candidates and max_value_candidates:
        overall_min_value = min(min_value_candidates)
        overall_max_value = max(max_value_candidates)
        if overall_min_value < overall_max_value:
            default_min_value = overall_min_value
            default_max_value = overall_max_value
            if saved_params:
                saved_min = safe_float(saved_params.get("value_min"))
                saved_max = safe_float(saved_params.get("value_max"))
                if saved_min is not None:
                    default_min_value = max(overall_min_value, min(saved_min, overall_max_value))
                if saved_max is not None:
                    default_max_value = min(overall_max_value, max(saved_max, overall_min_value))
            if default_min_value > default_max_value:
                default_min_value, default_max_value = overall_min_value, overall_max_value

    with st.sidebar.form("query_filter_form", clear_on_submit=False):
        indicator_name_selected = st.selectbox(
            "按指标名称筛选",
            options=indicator_name_options,
            index=indicator_name_options.index(default_name_option),
        )
        indicator_code_selected = st.selectbox(
            "按指标代码筛选",
            options=indicator_code_options,
            index=indicator_code_options.index(default_code_option),
        )

        date_start_iso = default_date_start_iso
        date_end_iso = default_date_end_iso
        if overall_start is not None and overall_end is not None and default_start is not None and default_end is not None:
            picked_range = st.date_input(
                "按日期范围筛选",
                value=(default_start, default_end),
                min_value=overall_start,
                max_value=overall_end,
            )
            if isinstance(picked_range, tuple) and len(picked_range) == 2:
                start_date, end_date = picked_range
            elif isinstance(picked_range, date):
                start_date = end_date = picked_range
            else:
                start_date, end_date = default_start, default_end
            if start_date > end_date:
                start_date, end_date = end_date, start_date
            date_start_iso = start_date.strftime("%Y-%m-%d")
            date_end_iso = end_date.strftime("%Y-%m-%d")

        apply_value_filter = False
        value_min_filter = None
        value_max_filter = None
        if (
            overall_min_value is not None
            and overall_max_value is not None
            and default_min_value is not None
            and default_max_value is not None
            and overall_min_value < overall_max_value
        ):
            apply_value_filter = st.checkbox("启用数值范围筛选", value=default_apply_value)
            if apply_value_filter:
                value_min_filter, value_max_filter = st.slider(
                    "按数值范围筛选",
                    min_value=float(overall_min_value),
                    max_value=float(overall_max_value),
                    value=(float(default_min_value), float(default_max_value)),
                )

        action_col1, action_col2 = st.columns(2)
        query_clicked = action_col1.form_submit_button("查询", type="primary", width="stretch")
        reset_clicked = action_col2.form_submit_button("重置", width="stretch")

    if reset_clicked:
        st.session_state["last_query_params"] = None
        st.rerun()

    if query_clicked:
        st.session_state["last_query_params"] = {
            "active_key": active_key,
            "indicator_name": indicator_name_selected,
            "indicator_code": indicator_code_selected,
            "date_start_iso": date_start_iso,
            "date_end_iso": date_end_iso,
            "apply_value_filter": apply_value_filter,
            "value_min": value_min_filter,
            "value_max": value_max_filter,
        }
        st.rerun()

    query_params = st.session_state.get("last_query_params")
    if not query_params or query_params.get("active_key") != active_key:
        query_params = {
            "active_key": active_key,
            "indicator_name": "全部",
            "indicator_code": "全部",
            "date_start_iso": default_date_start_iso,
            "date_end_iso": default_date_end_iso,
            "apply_value_filter": False,
            "value_min": None,
            "value_max": None,
        }
        st.caption("当前是右侧所选数据表的基础结果。左侧选择条件后点击“查询”可进一步过滤。")
    else:
        st.caption("已应用左侧查询条件。")

    indicator_name_kw = "" if query_params.get("indicator_name") == "全部" else query_params.get("indicator_name", "")
    indicator_code_kw = "" if query_params.get("indicator_code") == "全部" else query_params.get("indicator_code", "")

    with st.spinner("正在查询数据..."):
        table_counts: Dict[str, int] = {}
        frame_list = []
        for meta in table_meta_list:
            try:
                df_part = fetch_filtered_data(
                    sig,
                    meta["table_name"],
                    meta["col_map_items"],
                    str(indicator_code_kw).strip(),
                    str(indicator_name_kw).strip(),
                    str(query_params.get("date_start_iso", "")),
                    str(query_params.get("date_end_iso", "")),
                    bool(query_params.get("apply_value_filter", False)),
                    safe_float(query_params.get("value_min")),
                    safe_float(query_params.get("value_max")),
                )
            except Exception as exc:
                st.warning(f"读取 `{meta['cn']}` 失败：{exc}")
                continue

            table_counts[meta["cn"]] = len(df_part)
            if not df_part.empty:
                df_part["source_table"] = f"{meta['cn']} / {meta['en']}"
                frame_list.append(df_part)

    total_rows = sum(table_counts.values())
    st.subheader("📋 查询结果")
    count_detail = " | ".join([f"{cn}: {count:,}" for cn, count in table_counts.items()]) if table_counts else "无明细"
    st.markdown(
        f"""
        <div class="result-bar">
            <p class="result-count">匹配记录数：{total_rows:,}</p>
            <p class="result-sub">{count_detail}</p>
        </div>
        """,
        unsafe_allow_html=True,
    )

    if not frame_list:
        st.warning("当前筛选条件下没有数据。")
        return

    df = pd.concat(frame_list, ignore_index=True)

    st.subheader("📋 数据表")
    display_df = df[["indicator_code", "indicator_name", "value", "unit", "frequency", "datetime"]].copy()
    display_df["datetime"] = display_df["datetime"].dt.strftime("%Y-%m-%d %H:%M:%S").fillna("")
    display_df.rename(
        columns={
            "indicator_code": "indicator code",
            "indicator_name": "indicator name",
        },
        inplace=True,
    )

    st.dataframe(display_df, width="stretch", hide_index=True, height=520)

    csv_bytes = display_df.to_csv(index=False).encode("utf-8-sig")
    file_date = datetime.now().strftime("%Y%m%d_%H%M%S")
    table_tag = "multi" if len(table_meta_list) > 1 else table_meta_list[0]["cn"]
    st.download_button(
        label="💾 导出 CSV",
        data=csv_bytes,
        file_name=f"{table_tag}_{file_date}.csv",
        mime="text/csv",
        width="content",
    )

    numeric_values = pd.to_numeric(df["value"], errors="coerce").dropna()
    st.subheader("📈 数值统计")
    c1, c2, c3, c4, c5 = st.columns(5)
    stat_card(c1, "平均值", format_number(numeric_values.mean() if not numeric_values.empty else None))
    stat_card(c2, "最小值", format_number(numeric_values.min() if not numeric_values.empty else None))
    stat_card(c3, "最大值", format_number(numeric_values.max() if not numeric_values.empty else None))
    stat_card(c4, "中位数", format_number(numeric_values.median() if not numeric_values.empty else None))
    stat_card(c5, "标准差", format_number(numeric_values.std() if not numeric_values.empty else None))

    st.subheader("📉 趋势图")
    trend_df = df.dropna(subset=["datetime", "value"]).copy()
    if trend_df.empty:
        st.info("当前数据不包含可用于趋势图的有效时间或数值。")
    else:
        indicator_options = sorted(
            trend_df["indicator_name"].dropna().astype(str).unique().tolist()
        )
        selected_indicators = st.multiselect(
            "选择指标名称（可单选/多选）",
            options=indicator_options,
            default=indicator_options[:1] if indicator_options else [],
        )
        if not selected_indicators:
            st.info("请先选择至少一个指标名称，再查看趋势图。")
            return

        trend_df = trend_df[trend_df["indicator_name"].astype(str).isin(selected_indicators)].copy()
        if trend_df.empty:
            st.info("当前选择的指标在筛选结果中没有有效数值。")
            return

        trend_df = trend_df.sort_values("datetime")
        min_date = trend_df["datetime"].min().date()
        max_date = trend_df["datetime"].max().date()

        ctl_col1, ctl_col2 = st.columns([1.7, 1.3])
        with ctl_col1:
            picked_date_range = st.slider(
                "时间范围",
                min_value=min_date,
                max_value=max_date,
                value=(min_date, max_date),
                format="YYYY-MM-DD",
            )

        y_min_data = float(trend_df["value"].min())
        y_max_data = float(trend_df["value"].max())
        with ctl_col2:
            if y_min_data < y_max_data:
                picked_y_range = st.slider(
                    "Y轴范围",
                    min_value=y_min_data,
                    max_value=y_max_data,
                    value=(y_min_data, y_max_data),
                )
            else:
                picked_y_range = (y_min_data, y_max_data)
                st.caption("当前指标数值波动较小，Y轴范围固定。")

        start_dt = pd.to_datetime(picked_date_range[0])
        end_dt = pd.to_datetime(picked_date_range[1]) + timedelta(days=1)
        trend_df = trend_df[(trend_df["datetime"] >= start_dt) & (trend_df["datetime"] < end_dt)].copy()
        if trend_df.empty:
            st.info("当前时间范围内没有可展示的趋势数据。")
            return

        fig = px.line(
            trend_df,
            x="datetime",
            y="value",
            color="indicator_name",
            template="plotly_white",
        )
        fig.update_layout(
            margin=dict(l=18, r=18, t=16, b=8),
            height=430,
            legend_title_text="指标名称",
            xaxis_title="datetime",
            yaxis_title="value",
            dragmode="pan",
        )
        fig.update_xaxes(
            rangeselector=dict(
                buttons=[
                    dict(count=1, label="1M", step="month", stepmode="backward"),
                    dict(count=3, label="3M", step="month", stepmode="backward"),
                    dict(count=6, label="6M", step="month", stepmode="backward"),
                    dict(count=1, label="1Y", step="year", stepmode="backward"),
                    dict(step="all", label="全部"),
                ]
            ),
            rangeslider=dict(visible=False),
            range=[start_dt, end_dt - timedelta(seconds=1)],
        )
        fig.update_yaxes(range=[picked_y_range[0], picked_y_range[1]], fixedrange=False)
        st.plotly_chart(
            fig,
            use_container_width=True,
            config={
                "scrollZoom": True,
                "displaylogo": False,
                "modeBarButtonsToRemove": ["lasso2d", "select2d"],
            },
        )
        st.caption("操作提示：可用鼠标滚轮缩放，拖动画布平移；上方按钮可快速切换时间范围。")


if __name__ == "__main__":
    main()
