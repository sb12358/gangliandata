# pkg - Futures Multi-Table Dashboard

基于 Python + Streamlit + MySQL 的期货数据可视化网站。

## 功能

- 六张表统一查看（按中英文映射切换）
- 侧边栏筛选：
  - 指标名称
  - 指标代码
  - 日期范围
  - 数值范围
- 数值统计：平均值、最小值、最大值、中位数、标准差
- 趋势图：按时间展示指标变化
- 导出 CSV：下载筛选后的结果
- 数据表仅展示字段：
  - `indicator code`
  - `indicator name`
  - `value`
  - `unit`
  - `frequency`
  - `datetime`

## 与 qxjh 隔离

- 本项目单独目录：`/Users/shaobin/Desktop/code/pkg`
- 本项目单独虚拟环境：`pkg/.venv`
- 默认端口：`8502`（避免占用常见的 `8501`）

## 启动

```bash
cd /Users/shaobin/Desktop/code/pkg
cp .env.example .env
./start.sh
```

启动后访问：

- `http://localhost:8502`

## 数据库配置

默认已经写入 `.env.example`：

```env
DB_HOST=10.10.10.120
DB_PORT=3306
DB_USER=root
DB_PASSWORD=eiNg6pie
DB_NAME=futures
APP_PORT=8502
```

如果你有新配置，修改 `.env` 即可。
